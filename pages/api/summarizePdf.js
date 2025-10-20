import axios from "axios";
import pdf from "pdf-parse";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = "congressionalSummaries";
const COLLECTION_NAME = "summaries";
const CHUNK_COLLECTION = "chunkSummaries";

const openai = new OpenAI( { apiKey: process.env.OPENAI_API_KEY } );

let cachedClient = null;
let cachedDb = null;

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

async function summarizeChunk( chunk, chunkIndex ) {
    const response = await openai.chat.completions.create( {
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
            {
                role: "system",
                content: `
                Return your response in Markdown. You are an expert political analyst tasked with summarizing a section of the official U.S. Congressional Record. Summarize the entire contents of the provided text, including full remarks made by each speaker. Be sure to: Identify and name each speaker when they begin speaking. Include party affiliation by appending (D) for Democrat or (R) for Republican after their name. Capture and explain the key arguments, themes, and rhetorical points made by each speaker, preserving the intent and tone of their statements. Do not omit or paraphrase away the core content of any speech—summarize completely and clearly. If any bills, resolutions, or motions are introduced or passed, be sure to: Clearly name the bill/resolution. Describe its contents and intended effects in plain language. Explain the implications of the bill, especially if debated. If any controversial statements, debates, or points of tension arise, highlight: Who said what, the context and significance of the remarks, any possible public or political impact of the bill. Formatting Instructions: Write in paragraphs of 5 to 7 sentences each. Separate each paragraph with a line break like

                "\[{Section 1}\]"
                
                  
                
                "\[{Section 2}\]
                
                  
                
                "\[{Section 3}\]
                
                ...
                
                followed after each paragraph for visual clarity and to make it easier to read. Use clear transitions between topics or speakers, with a bolded header title for each new section. Your goal is to create an accurate, readable summary that makes complex legislative discussions easy to follow while preserving factual detail.
                       `
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

        const db = await connectToDatabase();
        const collection = db.collection( COLLECTION_NAME );
        const chunkCollection = db.collection( CHUNK_COLLECTION );

        const existingSummary = await collection.findOne( { issueNumber } );
        if ( existingSummary?.summary ) {
            res.setHeader( "Content-Type", "application/json" );
            return res.end( JSON.stringify( { summary: existingSummary.summary } ) );
        }

        const pdfResponse = await axios.get( pdfUrl, { responseType: "arraybuffer" } );
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
            const cachedChunk = await chunkCollection.findOne( { issueNumber, chunkIndex: i } );
            let summaryText;
            if ( cachedChunk?.summary ) {
                console.log( `⚡ Using cached chunk ${ i }` );
                summaryText = cachedChunk.summary;
            } else {
                console.log( `✍️ Summarizing chunk ${ i + 1 } / ${ chunks.length }` );
                const result = await summarizeChunk( chunkText, i );
                summaryText = result.content;

                await chunkCollection.updateOne(
                    { issueNumber, chunkIndex: i },
                    { $set: { issueNumber, chunkIndex: i, summary: summaryText } },
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

        await collection.updateOne(
            { issueNumber },
            { $set: { issueNumber, pdfUrl, summary: fullSummary } },
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
