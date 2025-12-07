import { MongoClient } from 'mongodb';
import axios from 'axios';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = 'congressionalSummaries';
const COLLECTION_NAME = 'summaries';
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY;

export async function fetchCongressionalRecords() {
    try {
        const response = await axios.get( `https://api.congress.gov/v3/daily-congressional-record?api_key=${ CONGRESS_API_KEY }`, {
            params: {
                format: 'json',
                limit: 250,
                offset: 0
            },
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            }
        } );

        if ( !response.data?.dailyCongressionalRecord ) {
            throw new Error( 'Invalid API response format' );
        }

        // Format and filter the data
        return response.data.dailyCongressionalRecord
            .filter( record => record && typeof record === 'object' )
            .map( record => ( {
                congress: record.congress,
                issueDate: record.issueDate,
                issueNumber: record.issueNumber,
                sessionNumber: record.sessionNumber,
                updateDate: record.updateDate,
                url: record.url,
                volumeNumber: record.volumeNumber,
                fetchedAt: new Date() // Timestamp for when the data was fetched
            } ) );
    } catch ( error ) {
        console.error( 'Error fetching Congressional Records:', error.message );
        return [];
    }
}

export async function storeRecordsInMongo( records ) {
    if ( records.length === 0 ) {
        console.log( 'No new records to store.' );
        return;
    }

    const client = new MongoClient( MONGODB_URI );

    try {
        await client.connect();
        const db = client.db( DATABASE_NAME );
        const collection = db.collection( COLLECTION_NAME );

        // Insert records while avoiding duplicates
        for ( const record of records ) {
            const existingRecord = await collection.findOne( { issueNumber: record.issueNumber, volumeNumber: record.volumeNumber } );

            if ( !existingRecord ) {
                await collection.insertOne( record );
                console.log( `Inserted record: Vol. ${ record.volumeNumber }, Issue ${ record.issueNumber }` );
            } else {
                console.log( `Record already exists: Vol. ${ record.volumeNumber }, Issue ${ record.issueNumber }` );
            }
        }
    } catch ( error ) {
        console.error( 'Error storing records in MongoDB:', error.message );
    } finally {
        await client.close();
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
