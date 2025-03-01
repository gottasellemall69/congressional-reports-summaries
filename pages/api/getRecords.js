import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = 'congressionalSummaries';
const COLLECTION_NAME = 'summaries';

let cachedClient = null;
let cachedDb = null;

export async function connectToDatabase() {
    if ( cachedClient && cachedDb ) {
        return { client: cachedClient, db: cachedDb };
    }

    const client = await MongoClient.connect( MONGODB_URI );
    const db = client.db( DATABASE_NAME );

    cachedClient = client;
    cachedDb = db;
    return { client, db };
}

export default async function handler( req, res ) {
    try {
        const { db } = await connectToDatabase();
        console.log( "📌 Fetching records from MongoDB..." );

        const records = await db
            .collection( COLLECTION_NAME )
            .find( {} )
            .sort( { issueDate: -1 } ) // 👈 Sort by date DESC (newest first)
            .toArray();

        console.log( "✅ Fetched and sorted records:", records );

        const updatedRecords = records.map( record => ( {
            ...record,
            url: `${ record.url }&api_key=${ process.env.CONGRESS_API_KEY }`
        } ) );

        res.status( 200 ).json( { success: true, data: updatedRecords } );
    } catch ( error ) {
        console.error( "❌ Error fetching records:", error );
        res.status( 500 ).json( { success: false, message: "Error fetching records" } );
    }
}
