import fetchAndStoreRecords from "@/pages/api/summarizeRecords";

export default async function handler( req, res ) {
    if ( req.method !== "GET" ) {
        return res.status( 405 ).end( "Method Not Allowed" );
    }

    // Verify CRON_SECRET to prevent unauthorized access
    if ( req.headers.authorization !== `Bearer ${ process.env.CRON_SECRET }` ) {
        return res.status( 401 ).end( "Unauthorized" );
    }

    try {
        console.log( "🚀 Running Vercel Cron Job: Fetching congressional reports..." );
        await fetchAndStoreRecords();
        return res.status( 200 ).json( { success: true, message: "Reports fetched successfully" } );
    } catch ( error ) {
        console.error( "❌ Error in cron job:", error );
        return res.status( 500 ).json( { success: false, error: error.message } );
    }
}
