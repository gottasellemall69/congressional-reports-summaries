import React, { useEffect, useState } from "react";
import axios from "axios";
import { FileText, Calendar, RefreshCw, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";

export default function Home() {
  const [ records, setRecords ] = useState( [] );
  const [ loading, setLoading ] = useState( true );
  const [ error, setError ] = useState( null );
  const [ selectedSummary, setSelectedSummary ] = useState( null );
  const [ loadingSummaries, setLoadingSummaries ] = useState( {} ); // Tracks which records are being summarized

  useEffect( () => {
    fetchRecords();
  }, [] );

  const fetchRecords = async () => {
    setLoading( true );
    try {
      const response = await axios.get( "/api/getRecords" );
      setRecords( response.data.data );
    } catch ( err ) {
      setError( "Failed to fetch congressional records." );
    } finally {
      setLoading( false );
    }
  };

  const summarizePdf = async ( pdfUrl, issueNumber ) => {
    setLoadingSummaries( ( prev ) => ( { ...prev, [ issueNumber ]: true } ) );

    try {
      const response = await axios.post( "/api/summarizePdf", { pdfUrl, issueNumber } );
      setSelectedSummary( response.data.summary );
    } catch ( err ) {
      setSelectedSummary( "Failed to summarize this document." );
    } finally {
      setLoadingSummaries( ( prev ) => ( { ...prev, [ issueNumber ]: false } ) );
    }
  };


  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-black shadow">
        <div className="max-w-7xl mx-auto px-4 py-6 flex justify-between">
          <h1 className="text-3xl font-bold">Congressional Record Daily</h1>
          <button onClick={ fetchRecords } disabled={ loading } className="px-4 py-2 bg-blue-600 text-white rounded-md flex flex-row gap-2 text-nowrap">
            <RefreshCw className={ loading ? "animate-spin" : "" } /> Refresh
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        { loading ? (
          <p>Loading...</p>
        ) : error ? (
          <p className="text-red-500">{ error }</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 flex-wrap mx-auto gap-6">
            { records.map( ( record, index ) => {
              const pdfUrl = record.contents?.issue?.fullIssue?.entireIssue?.[ 0 ]?.url;
              return (
                <div key={ `${ record.issueNumber }-${ index }` } className="bg-black p-6 shadow rounded-lg">
                  <h2 className="text-xl font-semibold">Vol. { record.volumeNumber }, Issue { record.issueNumber }</h2>
                  <p>{ format( parseISO( record.issueDate ), "MM-dd-yyyy" ) } {/* Formats correctly */ }</p>

                  <div className="mt-4 flex gap-4">
                    <a href={ pdfUrl } target="_blank" rel="noopener noreferrer" className="text-blue-600 flex items-center">
                      View PDF <ExternalLink className="ml-1" />
                    </a>
                    <button
                      onClick={ () => summarizePdf( pdfUrl, record.issueNumber ) }
                      className="text-green-600 flex items-center"
                      disabled={ loadingSummaries[ record.issueNumber ] } // Check if this specific issue is loading
                    >
                      { loadingSummaries[ record.issueNumber ] ? "Summarizing..." : "View Summary" }
                    </button>
                  </div>
                </div>
              );
            } ) }
          </div>
        ) }
      </main>

      { selectedSummary && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-black p-6 rounded-lg max-w-2xl">
            <h2 className="text-xl font-semibold mb-4">Summary</h2>
            <p>{ selectedSummary }</p>
            <button onClick={ () => setSelectedSummary( null ) } className="mt-4 px-4 py-2 bg-red-600 text-white rounded-md">
              Close
            </button>
          </div>
        </div>
      ) }
    </div>
  );
}
