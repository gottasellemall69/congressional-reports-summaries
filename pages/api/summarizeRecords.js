require( 'dotenv' ).config();
const { MongoClient } = require( 'mongodb' );
const axios = require( 'axios' );

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = 'congressionalSummaries';
const COLLECTION_NAME = 'summaries';
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

// Create a single MongoDB client instance
let client;

export async function connectToDatabase() {
    if ( !client ) {
        client = new MongoClient( MONGODB_URI );
        await client.connect();
    }
    return client.db( DATABASE_NAME );
}

async function fetchCongressionalRecords( retries = 3 ) {
    for ( let i = 0; i < retries; i++ ) {
        try {
            const response = await axios.get( `https://api.congress.gov/v3/daily-congressional-record?api_key=${ CONGRESS_API_KEY }`, {
                params: {
                    format: 'json',
                    limit: 250,
                    offset: 0
                },
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
            } );

            if ( !response.data?.dailyCongressionalRecord ) {
                throw new Error( 'Invalid API response format' );
            }

            // Fetch full contents for each report & include the API key in stored URL
            const reports = await Promise.all( response.data.dailyCongressionalRecord.map( async ( record ) => {
                try {
                    const reportUrl = `${ record.url }&api_key=${ CONGRESS_API_KEY }`; // Ensure stored URL has the key

                    const reportResponse = await axios.get( reportUrl, {
                        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
                    } );

                    return {
                        congress: record.congress,
                        issueDate: record.issueDate,
                        issueNumber: record.issueNumber,
                        sessionNumber: record.sessionNumber,
                        updateDate: record.updateDate,
                        url: reportUrl, // Store the API key-embedded URL
                        volumeNumber: record.volumeNumber,
                        fetchedAt: new Date(), // Timestamp
                        contents: reportResponse.data // Store the full contents of the report
                    };
                } catch ( reportError ) {
                    console.error( `Error fetching report contents from ${ record.url }:`, reportError.message );
                    return null;
                }
            } ) );

            return reports.filter( report => report !== null ); // Remove failed fetches
        } catch ( error ) {
            console.error( `Error fetching Congressional Records (attempt ${ i + 1 }):`, error.message );
            if ( i === retries - 1 ) return [];
            await new Promise( res => setTimeout( res, 2000 * Math.pow( 2, i ) ) ); // Exponential backoff
        }
    }
}

export async function storeRecordsInMongo( records ) {
    if ( records.length === 0 ) {
        console.log( 'No new records to store.' );
        return;
    }

    const db = await connectToDatabase();
    const collection = db.collection( COLLECTION_NAME );

    // Use bulk operations to prevent duplicate checking inefficiency
    const bulkOps = records.map( record => ( {
        updateOne: {
            filter: { issueNumber: record.issueNumber, volumeNumber: record.volumeNumber },
            update: { $setOnInsert: record }, // Inserts only if it doesn't exist
            upsert: true // Creates if not found
        }
    } ) );

    try {
        const result = await collection.bulkWrite( bulkOps );
        console.log( `Inserted ${ result.upsertedCount } new records, ${ result.matchedCount } already existed.` );
    } catch ( error ) {
        console.error( 'Error storing records in MongoDB:', error.message );
    }
}

export default async function fetchAndStoreRecords() {
    const records = await fetchCongressionalRecords();
    await storeRecordsInMongo( records );
}

// Run the function
fetchAndStoreRecords()
    .then( () => console.log( 'Congressional Record fetching complete.' ) )
    .catch( err => console.error( 'Unexpected error:', err ) );
