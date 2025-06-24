import axios from "axios";
import pdf from "pdf-parse";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = "congressionalSummaries";
const COLLECTION_NAME = "summaries";
const CHUNK_COLLECTION = "chunkSummaries";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI( { apiKey: OPENAI_API_KEY } );

async function connectToDatabase() {
    const client = new MongoClient( MONGODB_URI );
    await client.connect();
    return client.db( DATABASE_NAME );
}

function splitIntoChunks( text, maxWords = 10000 ) {
    const words = text.split( /\s+/ );
    const chunks = [];

    for ( let i = 0; i < words.length; i += maxWords ) {
        chunks.push( words.slice( i, i + maxWords ).join( " " ) );
    }

    return chunks;
}

async function summarizeChunk( chunk, chunkIndex ) {
    const response = await openai.chat.completions.create( {
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
            {
                role: "system",
                content: "You are an expert political analyst tasked with summarizing a section of the official U.S. Congressional Record. Summarize the entire contents of the provided text, including full remarks made by each speaker. Be sure to: Identify and name each speaker when they begin speaking. Include party affiliation by appending (D) for Democrat or (R) for Republican after their name. Capture and explain the key arguments, themes, and rhetorical points made by each speaker, preserving the intent and tone of their statements. Do not omit or paraphrase away the core content of any speech—summarize completely and clearly. If any bills, resolutions, or motions are introduced or passed, be sure to: Clearly name the bill/resolution. Describe its contents and intended effects in plain language. Explain the implications of the bill, especially if debated. If any controversial statements, debates, or points of tension arise, highlight: Who said what The context and significance of the remarks Any possible public or political impact Formatting Instructions: Write in paragraphs of 5–7 sentences each Separate each paragraph with <br /> followed by two line breaks Use clear transitions between topics or speakers Your goal is to create an accurate, readable summary that makes complex legislative discussions easy to follow while preserving factual detail."
            },
            {
                role: "user",
                content: chunk
            }
        ]
    } );

    return {
        index: chunkIndex,
        content: response.choices[ 0 ].message.content
    };
}

export default async function handler( req, res ) {
    if ( req.method !== "POST" ) {
        return res.status( 405 ).json( { error: "Method not allowed" } );
    }

    try {
        const { pdfUrl, issueNumber } = req.body;
        if ( !pdfUrl || !issueNumber ) {
            return res.status( 400 ).json( { error: "Missing PDF URL or Issue Number" } );
        }

        // Validate issueNumber
        if ( typeof issueNumber !== "string" && typeof issueNumber !== "number" ) {
            return res.status( 400 ).json( { error: "Invalid Issue Number format" } );
        }

        // Validate the PDF URL

        const db = await connectToDatabase();
        const collection = db.collection( COLLECTION_NAME );
        const chunkCollection = db.collection( CHUNK_COLLECTION );

        // ✅ Check for full cached summary
        const existingSummary = await collection.findOne( { issueNumber } );
        if ( existingSummary && existingSummary.summary ) {
            console.log( `📌 Using cached full summary for Issue ${ issueNumber }` );
            return res.status( 200 ).json( { summary: existingSummary.summary } );
        }

        // ❌ No full summary → process PDF
        console.log( `⏳ Downloading and parsing PDF for Issue ${ issueNumber }` );
        const pdfResponse = await axios.get( pdfUrl, { responseType: "arraybuffer" } );
        const pdfBuffer = Buffer.from( pdfResponse.data );
        const data = await pdf( pdfBuffer );
        const textContent = data.text;
        const chunks = splitIntoChunks( textContent );

        const chunkSummaries = [];

        for ( let i = 0; i < chunks.length; i++ ) {
            const chunkText = chunks[ i ];

            // ✅ Check if this chunk was summarized before
            const cachedChunk = await chunkCollection.findOne( { issueNumber, chunkIndex: i } );
            if ( cachedChunk && cachedChunk.summary ) {
                console.log( `⚡ Using cached chunk ${ i }` );
                chunkSummaries.push( { index: i, content: cachedChunk.summary } );
                continue;
            }

            // ❗ Summarize chunk
            console.log( `✍️ Summarizing chunk ${ i + 1 } / ${ chunks.length }` );
            const result = await summarizeChunk( chunkText, i );

            // ✅ Cache chunk summary
            await chunkCollection.updateOne(
                { issueNumber, chunkIndex: i },
                { $set: { issueNumber, chunkIndex: i, summary: result.content } },
                { upsert: true }
            );

            chunkSummaries.push( result );
        }

        // 🧠 Reconstruct full summary in order
        chunkSummaries.sort( ( a, b ) => a.index - b.index );
        const fullSummary = chunkSummaries.map( ( chunk ) => chunk.content ).join( "\n\n" );

        // ✅ Save full summary to main collection
        await collection.updateOne(
            { issueNumber },
            { $set: { issueNumber, pdfUrl, summary: fullSummary } },
            { upsert: true }
        );

        return res.status( 200 ).json( { summary: fullSummary } );
    } catch ( error ) {
        console.error( "❌ Error in summary handler:", error.message );
        return res.status( 500 ).json( { error: "Failed to summarize PDF" } );
    }
}






