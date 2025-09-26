// app/api/summarize/route.js
import { NextResponse } from "next/server";
import pdf from "pdf-parse";
import axios from "axios";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const openai = new OpenAI( { apiKey: process.env.OPENAI_API_KEY } );

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = "congressionalSummaries";
const COLLECTION_NAME = "summaries";
const CHUNK_COLLECTION = "chunkSummaries";

async function connectToDatabase() {
    const client = new MongoClient( MONGODB_URI );
    await client.connect();
    return client.db( DATABASE_NAME );
}

function splitIntoChunks( text, maxWords = 20000 ) {
    const words = text.split( /\s+/ );
    const chunks = [];
    for ( let i = 0; i < words.length; i += maxWords ) {
        chunks.push( words.slice( i, i + maxWords ).join( " " ) );
    }
    return chunks;
}

export async function POST( req ) {
    try {
        const { pdfUrl, issueNumber } = await req.json();
        if ( !pdfUrl || !issueNumber ) {
            return NextResponse.json( { error: "Missing required fields" }, { status: 400 } );
        }

        const db = await connectToDatabase();
        const summaries = db.collection( COLLECTION_NAME );
        const chunkSummaries = db.collection( CHUNK_COLLECTION );

        const cached = await summaries.findOne( { issueNumber } );
        if ( cached?.summary ) {
            return NextResponse.json( { summary: cached.summary } );
        }

        const pdfResponse = await axios.get( pdfUrl, { responseType: "arraybuffer" } );
        const data = await pdf( Buffer.from( pdfResponse.data ) );
        const chunks = splitIntoChunks( data.text );

        const stream = new ReadableStream( {
            async start( controller ) {
                const encoder = new TextEncoder();
                controller.enqueue( encoder.encode( JSON.stringify( { totalChunks: chunks.length } ) + "\n" ) );

                const allSummaries = [];

                for ( let i = 0; i < chunks.length; i++ ) {
                    let content;

                    const cachedChunk = await chunkSummaries.findOne( { issueNumber, chunkIndex: i } );
                    if ( cachedChunk?.summary ) {
                        content = cachedChunk.summary;
                    } else {
                        const response = await openai.chat.completions.create( {
                            model: "gpt-4o-mini",
                            temperature: 0.3,
                            messages: [
                                {
                                    role: "system",
                                    content: `Return your response in Markdown. You are an expert political analyst tasked with summarizing a section of the official U.S. Congressional Record. Summarize the entire contents of the provided text, including full remarks made by each speaker. Be sure to: Identify and name each speaker when they begin speaking. Include party affiliation by appending (D) for Democrat or (R) for Republican after their name. Capture and explain the key arguments, themes, and rhetorical points made by each speaker, preserving the intent and tone of their statements. Do not omit or paraphrase away the core content of any speech—summarize completely and clearly. If any bills, resolutions, or motions are introduced or passed, be sure to: Clearly name the bill/resolution. Describe its contents and intended effects in plain language. Explain the implications of the bill, especially if debated. If any controversial statements, debates, or points of tension arise, highlight: Who said what, the context and significance of the remarks, any possible public or political impact of the bill. Formatting Instructions: Write in paragraphs of 5 to 7 sentences each. Separate each paragraph with a line break ("\n") like "Section 1\nSection 2\nSection 3" followed after each paragraph for visual clarity and to make it easier to read. Use clear transitions between topics or speakers, with a bolded header title for each new section. Your goal is to create an accurate, readable summary that makes complex legislative discussions easy to follow while preserving factual detail. You are an expert political analyst tasked with summarizing a section of the official U.S. Congressional Record. Summarize the entire contents of the provided text, including full remarks made by each speaker. Be sure to: Identify and name each speaker when they begin speaking. Include party affiliation by appending (D) for Democrat or (R) for Republican after their name. Capture and explain the key arguments, themes, and rhetorical points made by each speaker, preserving the intent and tone of their statements. Do not omit or paraphrase away the core content of any speech—summarize completely and clearly. If any bills, resolutions, or motions are introduced or passed, be sure to: Clearly name the bill/resolution. Describe its contents and intended effects in plain language. Explain the implications of the bill, especially if debated. If any controversial statements, debates, or points of tension arise, highlight: Who said what, the context and significance of the remarks, any possible public or political impact of the bill. Formatting Instructions: Write in paragraphs of 5 to 7 sentences each. Separate each paragraph with a \n followed after each paragraph for visual clarity and to make it easier to read. Use clear transitions between topics or speakers, with a bolded header title for each new section, followed by a line break. Your goal is to create an accurate, readable summary that makes complex legislative discussions easy to follow while preserving factual detail.`
                                },
                                {
                                    role: "user",
                                    content: chunks[ i ]
                                }
                            ]
                        } );

                        content = response.choices[ 0 ].message.content;

                        await chunkSummaries.updateOne(
                            { issueNumber, chunkIndex: i },
                            { $set: { issueNumber, chunkIndex: i, summary: content } },
                            { upsert: true }
                        );
                    }

                    allSummaries.push( { index: i, content } );

                    controller.enqueue(
                        encoder.encode( JSON.stringify( { index: i, content } ) + "\n" )
                    );
                }

                allSummaries.sort( ( a, b ) => a.index - b.index );
                const finalSummary = allSummaries.map( ( c ) => c.content ).join( "\n\n" );

                await summaries.updateOne(
                    { issueNumber },
                    { $set: { issueNumber, pdfUrl, summary: finalSummary } },
                    { upsert: true }
                );

                controller.enqueue( encoder.encode( JSON.stringify( { summary: finalSummary } ) + "\n" ) );
                controller.close();
            }
        } );

        return new Response( stream, {
            headers: {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-cache"
            }
        } );
    } catch ( error ) {
        console.error( "❌ summarize route error:", error.message );
        return NextResponse.json( { error: error.message }, { status: 500 } );
    }
}
