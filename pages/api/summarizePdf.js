import axios from "axios";
import pdf from "pdf-parse";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DATABASE_NAME = "congressionalSummaries";
const COLLECTION_NAME = "summaries";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI( { apiKey: OPENAI_API_KEY } );

async function connectToDatabase() {
    const client = new MongoClient( MONGODB_URI );
    await client.connect();
    return client.db( DATABASE_NAME );
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

        // ✅ Check if a summary already exists in MongoDB
        const existingSummary = await collection.findOne( { issueNumber } );
        if ( existingSummary && existingSummary.summary ) {
            console.log( `📌 Using cached summary for Issue ${ issueNumber }` );
            return res.status( 200 ).json( { summary: existingSummary.summary } );
        }

        // ❗ No summary found → Fetch PDF and summarize
        console.log( `⏳ Generating new summary for Issue ${ issueNumber }` );

        // Download PDF
        const pdfResponse = await axios.get( pdfUrl, { responseType: "arraybuffer" } );
        const pdfBuffer = Buffer.from( pdfResponse.data );

        // Extract text from PDF
        const data = await pdf( pdfBuffer );
        const textContent = data.text.substring( 0, 5000 ); // Limit to avoid high token costs

        // Use GPT-3.5 Turbo to summarize
        const completion = await openai.chat.completions.create( {
            model: "gpt-3.5-turbo",
            temperature: 0.4,
            messages: [ {
                role: "system",
                content: "Summarize the following congressional record, including all topics discussed. Identify key points, summarize arguments made, and highlight any controversial views, specifying who expressed them."
            },
            { role: "user", content: textContent }
            ],
            max_completion_tokens: 1200
        } );

        const summary = completion.choices[ 0 ].message.content;

        // ✅ Store the new summary in MongoDB to prevent repeated API calls
        await collection.updateOne(
            { issueNumber },
            { $set: { summary, issueNumber, pdfUrl } },
            { upsert: true }
        );

        res.status( 200 ).json( { summary } );
    } catch ( error ) {
        console.error( "❌ Error summarizing PDF:", error.message );
        res.status( 500 ).json( { error: "Failed to summarize PDF" } );
    }
}
