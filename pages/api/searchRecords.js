import OpenAI from "openai";
import { connectToDatabase } from "./getRecords";

const COLLECTION_NAME = "summaries";
const EMBEDDING_MODEL = "text-embedding-3-small";

// Map of content keys to human readable labels
const SECTION_KEYS = {
    entireIssue: "Entire Issue",
    houseSection: "House",
    senateSection: "Senate",
    extensionsSection: "Extensions",
    dailyDigest: "Daily Digest"
};

const openai = process.env.OPENAI_API_KEY ? new OpenAI( { apiKey: process.env.OPENAI_API_KEY } ) : null;

const clampText = ( text, maxLength = 7000 ) => {
    if ( !text ) return "";
    return text.length > maxLength ? text.slice( 0, maxLength ) : text;
};

const buildMongoFilters = ( filters = {} ) => {
    const query = {};

    if ( filters.startDate || filters.endDate ) {
        query.issueDate = {};
        if ( filters.startDate ) query.issueDate.$gte = filters.startDate;
        if ( filters.endDate ) query.issueDate.$lte = filters.endDate;
    }

    if ( filters.volumeNumber ) {
        query.volumeNumber = filters.volumeNumber;
    }

    if ( filters.sessionNumber ) {
        query.sessionNumber = filters.sessionNumber;
    }

    if ( filters.hasSummaryOnly ) {
        query.summary = { $exists: true, $ne: "" };
    }

    if ( Array.isArray( filters.sections ) && filters.sections.length > 0 ) {
        // Require that at least one of the requested sections exists on the record
        query.$or = filters.sections.map( ( sectionKey ) => ( {
            [ `contents.issue.fullIssue.${ sectionKey }` ]: { $exists: true, $ne: null }
        } ) );
    }

    return query;
};

const cosineSimilarity = ( a, b ) => {
    if ( !Array.isArray( a ) || !Array.isArray( b ) || a.length !== b.length ) return null;
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for ( let i = 0; i < a.length; i++ ) {
        dot += a[ i ] * b[ i ];
        normA += a[ i ] * a[ i ];
        normB += b[ i ] * b[ i ];
    }

    if ( normA === 0 || normB === 0 ) return null;
    return dot / ( Math.sqrt( normA ) * Math.sqrt( normB ) );
};

const createEmbedding = async ( text ) => {
    if ( !openai ) return null;
    const trimmed = clampText( text );
    const response = await openai.embeddings.create( {
        model: EMBEDDING_MODEL,
        input: trimmed
    } );

    return response.data?.[ 0 ]?.embedding || null;
};

const extractSections = ( contents = {} ) => {
    const fullIssue = contents?.issue?.fullIssue ?? {};
    return Object.entries( SECTION_KEYS ).map( ( [ key, label ] ) => {
        const value = fullIssue?.[ key ];
        const urlCandidate = Array.isArray( value ) ? value[ 0 ]?.url : value?.url;

        return {
            key,
            label,
            url: urlCandidate || null,
            present: Boolean( urlCandidate )
        };
    } );
};

const ensureRecordEmbedding = async ( record, db ) => {
    if ( record.summaryEmbedding ) return record.summaryEmbedding;
    if ( !record.summary ) return null;

    const embedding = await createEmbedding( record.summary );
    if ( embedding ) {
        await db.collection( COLLECTION_NAME ).updateOne(
            { _id: record._id },
            { $set: { summaryEmbedding: embedding } }
        );
    }

    return embedding;
};

const buildPreview = ( summary, maxLength = 420 ) => {
    if ( !summary ) return null;
    const trimmed = summary.slice( 0, maxLength );
    return summary.length > maxLength ? `${ trimmed }…` : trimmed;
};

export default async function handler( req, res ) {
    if ( req.method !== "POST" ) {
        return res.status( 405 ).json( { success: false, message: "Method not allowed" } );
    }

    try {
        const { query = "", filters = {}, limit = 40 } = req.body || {};
        const { db } = await connectToDatabase();

        const mongoFilters = buildMongoFilters( filters );
        const cursor = db
            .collection( COLLECTION_NAME )
            .find( mongoFilters )
            .sort( { issueDate: -1 } )
            .limit( 250 );

        const records = await cursor.toArray();
        const sectionsForRecords = records.map( ( record ) => ( {
            ...record,
            sections: extractSections( record.contents )
        } ) );

        let results = sectionsForRecords;

        if ( query?.trim() ) {
            if ( !openai ) {
                // Fallback to keyword matching when no OpenAI key is set
                const lowered = query.trim().toLowerCase();
                results = sectionsForRecords
                    .map( ( record ) => {
                        const hasKeyword =
                            record.summary?.toLowerCase().includes( lowered ) ||
                            JSON.stringify( record.contents || {} ).toLowerCase().includes( lowered );
                        return { ...record, similarity: hasKeyword ? 1 : 0 };
                    } )
                    .filter( ( record ) => record.similarity > 0 );
            } else {
                const queryEmbedding = await createEmbedding( query );
                const scored = [];

                for ( const record of sectionsForRecords ) {
                    const recordEmbedding = await ensureRecordEmbedding( record, db );
                    if ( !recordEmbedding ) continue;

                    const similarity = cosineSimilarity( queryEmbedding, recordEmbedding );
                    if ( similarity === null ) continue;

                    scored.push( { ...record, similarity } );
                }

                scored.sort( ( a, b ) => b.similarity - a.similarity );
                results = scored.slice( 0, limit );
            }
        } else {
            results = results.slice( 0, limit );
        }

        const payload = results.map( ( record ) => ( {
            id: record._id?.toString?.() ?? record.issueNumber,
            issueNumber: record.issueNumber,
            issueDate: record.issueDate,
            volumeNumber: record.volumeNumber,
            sessionNumber: record.sessionNumber,
            url: record.url,
            pdfUrl: record.contents?.issue?.fullIssue?.entireIssue?.[ 0 ]?.url || record.url,
            summaryPreview: buildPreview( record.summary ),
            similarity: record.similarity,
            sections: record.sections?.filter( ( section ) => section.present ) ?? [],
            hasSummary: Boolean( record.summary ),
            updatedAt: record.updateDate || record.fetchedAt
        } ) );

        return res.status( 200 ).json( {
            success: true,
            count: payload.length,
            data: payload,
            appliedFilters: filters
        } );
    } catch ( error ) {
        console.error( "❌ Error in semantic search handler:", error.message );
        return res.status( 500 ).json( { success: false, message: "Failed to search records" } );
    }
}
