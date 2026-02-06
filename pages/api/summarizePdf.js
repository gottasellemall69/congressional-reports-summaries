import axios from "axios";
import pdf from "pdf-parse";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = "congressionalSummaries";
const COLLECTION_NAME = "summaries";
const CHUNK_COLLECTION = "chunkSummaries";

const openai = new OpenAI( { apiKey: process.env.OPENAI_API_KEY } );

const SUMMARY_SYSTEM_PROMPT = `
                Return your response in Markdown.
                You are an expert political analyst tasked with summarizing a section of the official U.S. Congressional Record.
                Your goal is to create an accurate, readable summary that makes complex legislative discussions easy to follow while preserving factual detail.
                Summarize the entire contents of the provided text, including full remarks made by each speaker.
                Use clear transitions between topics or speakers, with a bolded header title for each new section.
                Include party affiliation by appending (D) for Democrat or (R) for Republican after their name.
                
                ## Formatting Instructions:
                    # Write in paragraphs of 5 to 7 sentences each.
                    # Separate each paragraph with a line break:
                
                        "\[{Section 1}\]"
                
                        \n
                
                        "\[{Section 2}\]
                
                        \n
                
                        "\[{Section 3}\]
                
                        ...
                
                    followed after each paragraph for visual clarity and to make it easier to read.
                
                ## Be sure to: 
                    # Identify and name each speaker when they begin speaking.
                    # Capture and explain the key arguments, themes, and rhetorical points made by each speaker, preserving the intent and tone of their statements.
                    # Do not omit or paraphrase away the core content of any speech; always summarize completely and clearly.
                    # Cite your sources for each summary section/point/topic/analysis.

                ## If any bills, resolutions, or motions are introduced or passed, be sure to: 
                    # Clearly name the bill/resolution.
                    # Describe its contents and intended effects in plain language.
                    # Explain the implications of the bill, especially if debated.

                ## If any controversial statements, debates, or points of tension arise, highlight:
                    # Who said what, the context and significance of the remarks, any possible public or political impact of the bill.
                
                ## Formatting Instructions:
                    # Write in paragraphs of 5 to 7 sentences each.
                    
                    `;

const ALLOWED_PDF_HOSTS = new Set( [
    "api.congress.gov",
    "congress.gov",
    "www.congress.gov",
    "api.govinfo.gov",
    "govinfo.gov",
    "www.govinfo.gov"
] );
const ALLOWED_PDF_SUFFIXES = [ ".congress.gov", ".govinfo.gov" ];
const MAX_URL_LENGTH = 2048;
const CONTINUATION_TAIL_CHARS = 4000;
const CONTINUATION_PROMPT =
    "Continue exactly where you left off. Do not repeat any text. " +
    "Start immediately after the last character. If the summary is complete, respond with an empty string.";

let cachedClient = null;
let cachedDb = null;

const isPrivateIPv4 = ( hostname ) => {
    if ( !/^\d{1,3}(\.\d{1,3}){3}$/.test( hostname ) ) return false;
    const parts = hostname.split( "." ).map( Number );
    if ( parts.some( ( part ) => Number.isNaN( part ) || part < 0 || part > 255 ) ) return false;
    const [ a, b ] = parts;
    if ( a === 10 ) return true;
    if ( a === 127 ) return true;
    if ( a === 172 && b >= 16 && b <= 31 ) return true;
    if ( a === 192 && b === 168 ) return true;
    return false;
};

const isPrivateIPv6 = ( hostname ) => {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized.startsWith( "fe80:" ) || normalized.startsWith( "fc" ) || normalized.startsWith( "fd" );
};

const isAllowedPdfHost = ( hostname ) => {
    if ( ALLOWED_PDF_HOSTS.has( hostname ) ) return true;
    return ALLOWED_PDF_SUFFIXES.some( ( suffix ) => hostname.endsWith( suffix ) );
};

const validatePdfUrl = ( rawUrl ) => {
    if ( typeof rawUrl !== "string" ) {
        throw new Error( "Invalid PDF URL" );
    }
    const trimmed = rawUrl.trim();
    if ( trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH ) {
        throw new Error( "Invalid PDF URL" );
    }

    let parsed;
    try {
        parsed = new URL( trimmed );
    } catch ( error ) {
        throw new Error( "Invalid PDF URL" );
    }

    if ( parsed.protocol !== "https:" ) {
        throw new Error( "PDF URL must use https" );
    }
    if ( parsed.username || parsed.password ) {
        throw new Error( "PDF URL must not include credentials" );
    }

    const hostname = parsed.hostname.toLowerCase();
    if ( hostname === "localhost" || isPrivateIPv4( hostname ) || isPrivateIPv6( hostname ) ) {
        throw new Error( "PDF URL host is not allowed" );
    }
    if ( !isAllowedPdfHost( hostname ) ) {
        throw new Error( "PDF URL host is not allowed" );
    }
    if ( parsed.port && parsed.port !== "443" ) {
        throw new Error( "PDF URL port is not allowed" );
    }

    return parsed.toString();
};

const parsePositiveInt = ( value, label ) => {
    let numberValue;

    if ( typeof value === "number" ) {
        numberValue = value;
    } else if ( typeof value === "string" ) {
        const trimmed = value.trim();
        if ( !/^\d+$/.test( trimmed ) ) {
            throw new Error( `Invalid ${ label }` );
        }
        numberValue = Number.parseInt( trimmed, 10 );
    } else {
        throw new Error( `Invalid ${ label }` );
    }

    if ( !Number.isSafeInteger( numberValue ) || numberValue <= 0 ) {
        throw new Error( `Invalid ${ label }` );
    }
    return numberValue;
};

async function connectToDatabase() {
    if ( cachedClient && cachedDb ) {
        return cachedDb;
    }

    const client = new MongoClient( MONGODB_URI );
    await client.connect();
    cachedClient = client;
    cachedDb = client.db( DATABASE_NAME );
    return cachedDb;
}

function splitIntoChunks( text, maxWords = 20000 ) {
    const words = text.split( /\s+/ );
    const chunks = [];
    for ( let i = 0; i < words.length; i += maxWords ) {
        chunks.push( words.slice( i, i + maxWords ).join( " " ) );
    }
    return chunks;
}

async function createEmbedding( text ) {
    if ( !process.env.OPENAI_API_KEY ) return null;
    const trimmed = text.length > 7000 ? text.slice( 0, 7000 ) : text;
    const response = await openai.embeddings.create( {
        model: "text-embedding-3-small",
        input: trimmed
    } );

    return response.data?.[ 0 ]?.embedding || null;
}

const buildSummaryMessages = ( chunk ) => ( [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: chunk }
] );

const buildContinuationMessages = ( chunk, priorContent ) => {
    const tail = priorContent.slice( -CONTINUATION_TAIL_CHARS );
    return [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: chunk },
        { role: "assistant", content: tail },
        { role: "user", content: CONTINUATION_PROMPT }
    ];
};

async function summarizeChunk( chunk, chunkIndex ) {
    let combined = "";
    let attempt = 0;
    let finishReason = null;
    let previousLength = 0;
    let stagnantCount = 0;

    while ( attempt === 0 || finishReason === "length" ) {
        const messages = attempt === 0 ? buildSummaryMessages( chunk ) : buildContinuationMessages( chunk, combined );
        const response = await openai.chat.completions.create( {
            model: "gpt-4o-mini",
            temperature: 0.3,
            messages
        } );

        const content = response.choices?.[ 0 ]?.message?.content || "";
        finishReason = response.choices?.[ 0 ]?.finish_reason || null;

        if ( content.trim() ) {
            combined = combined ? `${ combined }\n\n${ content }` : content;
        } else {
            break;
        }

        if ( finishReason !== "length" ) {
            break;
        }

        if ( combined.length === previousLength ) {
            stagnantCount += 1;
        } else {
            stagnantCount = 0;
        }
        previousLength = combined.length;

        if ( stagnantCount >= 2 ) {
            console.warn( `⚠️ Chunk ${ chunkIndex } continuation stalled.` );
            break;
        }

        attempt += 1;
    }

    return { index: chunkIndex, content: combined };
}

export default async function handler( req, res ) {
    if ( req.method !== "POST" ) {
        return res.status( 405 ).json( { error: "Method not allowed" } );
    }

    try {
        const { pdfUrl, issueNumber, volumeNumber, issueDate } = req.body;
        if ( !pdfUrl || !issueNumber || !volumeNumber ) {
            return res.status( 400 ).json( { error: "Missing PDF URL, Issue Number, or Volume Number" } );
        }

        const safeIssueNumber = parsePositiveInt( issueNumber, "issue number" );
        const safeVolumeNumber = parsePositiveInt( volumeNumber, "volume number" );
        const safePdfUrl = validatePdfUrl( pdfUrl );
        const safeIssueDate =
            typeof issueDate === "string" && issueDate.trim().length > 0 && issueDate.trim().length <= 32
                ? issueDate.trim()
                : null;

        const db = await connectToDatabase();
        const collection = db.collection( COLLECTION_NAME );
        const chunkCollection = db.collection( CHUNK_COLLECTION );

        const existingSummary = await collection.findOne( { issueNumber: safeIssueNumber, volumeNumber: safeVolumeNumber } );
        if ( existingSummary?.summary ) {
            res.setHeader( "Content-Type", "application/json" );
            return res.end( JSON.stringify( { summary: existingSummary.summary } ) );
        }

        const pdfResponse = await axios.get( safePdfUrl, { responseType: "arraybuffer", maxRedirects: 0 } );
        const pdfBuffer = Buffer.from( pdfResponse.data );
        const data = await pdf( pdfBuffer );
        const textContent = data.text;
        const chunks = splitIntoChunks( textContent );

        const chunkSummaries = [];

        // Set headers for streaming response
        res.setHeader( "Content-Type", "application/json; charset=utf-8" );
        res.setHeader( "Transfer-Encoding", "chunked" );
        res.write( `{"totalChunks": ${ chunks.length }, "chunks":[\n` );


        for ( let i = 0; i < chunks.length; i++ ) {
            const chunkText = chunks[ i ];

            // Cached summary
            const cachedChunk = await chunkCollection.findOne( {
                issueNumber: safeIssueNumber,
                volumeNumber: safeVolumeNumber,
                chunkIndex: i
            } );
            let summaryText;
            if ( cachedChunk?.summary ) {
                console.log( `⚡ Using cached chunk ${ i }` );
                summaryText = cachedChunk.summary;
            } else {
                console.log( `✍️ Summarizing chunk ${ i + 1 } / ${ chunks.length }` );
                const result = await summarizeChunk( chunkText, i );
                summaryText = result.content;

                await chunkCollection.updateOne(
                    { issueNumber: safeIssueNumber, volumeNumber: safeVolumeNumber, chunkIndex: i },
                    { $set: { issueNumber: safeIssueNumber, volumeNumber: safeVolumeNumber, chunkIndex: i, summary: summaryText } },
                    { upsert: true }
                );
            }

            chunkSummaries.push( { index: i, content: summaryText } );

            const chunkJson = JSON.stringify( { index: i, content: summaryText } );
            res.write( `${ i > 0 ? "," : "" }${ chunkJson }\n` );
        }

        res.write( `], "summary":` );

        // Assemble full summary
        chunkSummaries.sort( ( a, b ) => a.index - b.index );
        const fullSummary = chunkSummaries.map( ( c ) => c.content ).join( "\n\n" );

        const summaryEmbedding = await createEmbedding( fullSummary );
        const summaryUpdate = { issueNumber: safeIssueNumber, volumeNumber: safeVolumeNumber, pdfUrl: safePdfUrl, summary: fullSummary };
        if ( safeIssueDate ) {
            summaryUpdate.issueDate = safeIssueDate;
        }
        if ( summaryEmbedding ) {
            summaryUpdate.summaryEmbedding = summaryEmbedding;
        }

        await collection.updateOne(
            { issueNumber: safeIssueNumber, volumeNumber: safeVolumeNumber },
            { $set: summaryUpdate },
            { upsert: true }
        );

        res.write( JSON.stringify( fullSummary ) );
        res.write( "}" );
        res.end();
    } catch ( error ) {
        console.error( "❌ Error in summary handler:", error.message );
        if ( !res.headersSent ) {
            res.status( 500 ).json( { error: "Failed to summarize PDF" } );
        } else {
            res.write( `], "error": ${ JSON.stringify( error.message ) }}` );
            res.end();
        }
    }
}
