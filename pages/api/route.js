import summarizePdfHandler from "./summarizePdf";

export default async function handler( req, res ) {
    return summarizePdfHandler( req, res );
}
