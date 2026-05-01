const DEFAULT_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
const DEFAULT_SUMMARY_TEMPERATURE = 0.3;

const extractOutputText = ( response ) => {
    if ( typeof response?.output_text === "string" ) {
        return response.output_text;
    }

    if ( !Array.isArray( response?.output ) ) {
        return "";
    }

    return response.output
        .flatMap( ( item ) => Array.isArray( item.content ) ? item.content : [] )
        .map( ( content ) => typeof content?.text === "string" ? content.text : "" )
        .join( "" );
};

export const createSummaryResponse = async ( openai, {
    instructions,
    input,
    model = DEFAULT_SUMMARY_MODEL,
    temperature = DEFAULT_SUMMARY_TEMPERATURE
} ) => {
    const response = await openai.responses.create( {
        model,
        temperature,
        instructions,
        input,
        store: false
    } );

    if ( response?.error ) {
        throw new Error( response.error.message || "OpenAI response failed" );
    }

    return {
        text: extractOutputText( response ),
        incompleteReason: response?.incomplete_details?.reason || null,
        raw: response
    };
};
