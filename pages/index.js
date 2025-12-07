import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  FileText,
  Calendar,
  RefreshCw,
  ExternalLink,
  Search,
  Filter,
  Sparkles,
  AlertTriangle
} from "lucide-react";
import { format, parseISO } from "date-fns";

const SECTION_OPTIONS = [
  { key: "entireIssue", label: "Entire Issue" },
  { key: "houseSection", label: "House" },
  { key: "senateSection", label: "Senate" },
  { key: "extensionsSection", label: "Extensions" },
  { key: "dailyDigest", label: "Daily Digest" }
];

const escapeRegExp = ( value ) => value.replace( /[.*+?^${}()|[\]\\]/g, "\\$&" );

export default function Home() {
  const [ records, setRecords ] = useState( [] );
  const [ loading, setLoading ] = useState( true );
  const [ searching, setSearching ] = useState( false );
  const [ error, setError ] = useState( null );
  const [ query, setQuery ] = useState( "" );
  const [ activeQuery, setActiveQuery ] = useState( "" );
  const [ filters, setFilters ] = useState( {
    startDate: "",
    endDate: "",
    sections: [],
    hasSummaryOnly: false,
    volumeNumber: "",
    sessionNumber: ""
  } );
  const [ selectedSummary, setSelectedSummary ] = useState( null );
  const [ loadingSummaries, setLoadingSummaries ] = useState( {} );

  const hasActiveFilters = useMemo( () => {
    return Boolean(
      filters.startDate ||
      filters.endDate ||
      filters.volumeNumber ||
      filters.sessionNumber ||
      filters.hasSummaryOnly ||
      filters.sections.length
    );
  }, [ filters ] );

  function buildPreview( summary ) {
    if ( !summary ) return null;
    const preview = summary.slice( 0, 420 );
    return summary.length > 420 ? `${ preview }…` : preview;
  }

  const fetchRecords = async ( override = {} ) => {
    setError( null );
    setLoading( !override.silent );
    setSearching( Boolean( override.query !== undefined ) );

    try {
      const response = await axios.post( "/api/searchRecords", {
        query: override.query ?? activeQuery,
        filters: {
          ...filters,
          sections: filters.sections
        },
        limit: 60
      } );

      setRecords( response.data.data || [] );
    } catch ( err ) {
      console.error( "Error fetching records", err );
      setError( "Failed to fetch congressional records." );
    } finally {
      setLoading( false );
      setSearching( false );
    }
  };

  useEffect( () => {
    fetchRecords();
  }, [] );

  useEffect( () => {
    fetchRecords( { silent: true } );
  }, [
    filters.startDate,
    filters.endDate,
    filters.hasSummaryOnly,
    filters.volumeNumber,
    filters.sessionNumber,
    JSON.stringify( filters.sections )
  ] );

  const summarizePdf = async ( pdfUrl, issueNumber ) => {
    setLoadingSummaries( ( prev ) => ( { ...prev, [ issueNumber ]: true } ) );

    try {
      const response = await fetch( "/api/summarizePdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify( { pdfUrl, issueNumber } )
      } );

      const reader = response.body.getReader();
      const decoder = new TextDecoder( "utf-8" );
      let buffer = "";

      while ( true ) {
        const { done, value } = await reader.read();
        if ( done ) break;

        buffer += decoder.decode( value, { stream: true } );
      }

      const parsed = JSON.parse( buffer );
      setSelectedSummary( parsed.summary );

      // Update the local record with the new summary preview so the card refreshes immediately
      setRecords( ( prev ) =>
        prev.map( ( rec ) =>
          rec.issueNumber === issueNumber
            ? { ...rec, summaryPreview: buildPreview( parsed.summary ), hasSummary: true }
            : rec
        )
      );
    } catch ( err ) {
      setSelectedSummary( "Failed to summarize this document." );
    } finally {
      setLoadingSummaries( ( prev ) => ( { ...prev, [ issueNumber ]: false } ) );
    }
  };

  const handleSectionToggle = ( key ) => {
    setFilters( ( prev ) => {
      const hasKey = prev.sections.includes( key );
      const nextSections = hasKey ? prev.sections.filter( ( section ) => section !== key ) : [ ...prev.sections, key ];
      return { ...prev, sections: nextSections };
    } );
  };

  const handleSearch = async ( event ) => {
    event.preventDefault();
    const normalizedQuery = query.trim();
    setActiveQuery( normalizedQuery );
    await fetchRecords( { query: normalizedQuery } );
  };

  const formatIssueDate = ( value ) => {
    if ( !value ) return "Unknown date";
    try {
      return format( parseISO( value ), "MMM d, yyyy" );
    } catch ( err ) {
      return value;
    }
  };

  const renderHighlighted = ( text ) => {
    if ( !text ) return <span className="text-slate-500">No summary saved yet.</span>;
    if ( !activeQuery ) return text;

    const terms = activeQuery.split( /\s+/ ).filter( Boolean );
    if ( terms.length === 0 ) return text;

    const regex = new RegExp( `(${ terms.map( escapeRegExp ).join( "|" ) })`, "gi" );
    return text.split( regex ).map( ( part, idx ) =>
      regex.test( part )
        ? <mark key={ idx } className="bg-yellow-200 text-slate-900 rounded px-0.5">{ part }</mark>
        : <React.Fragment key={ idx }>{ part }</React.Fragment>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-gradient-to-r from-slate-900 via-blue-900 to-indigo-800 text-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-wide text-indigo-200">Semantic explorer</p>
            <h1 className="text-3xl md:text-4xl font-bold">Congressional Record Daily</h1>
            <p className="text-sm text-indigo-100 mt-1 max-w-2xl">
              Search debates by meaning and filter by chamber, date, and volume to surface the reports you need.
            </p>
          </div>
          <button
            onClick={ () => fetchRecords( { query: activeQuery } ) }
            disabled={ loading }
            className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-md flex flex-row gap-2 text-nowrap border border-white/20"
          >
            <RefreshCw className={ `w-4 h-4 ${ loading ? "animate-spin" : "" }` } /> Refresh feed
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-6">
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-6">
          <form onSubmit={ handleSearch } className="flex flex-col gap-4">
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div className="relative flex-1">
                <Search className="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={ query }
                  onChange={ ( e ) => setQuery( e.target.value ) }
                  placeholder="Search by topic, bill, member, or phrase (semantic)"
                  className="w-full pl-10 pr-4 py-3 rounded-lg border border-slate-200 bg-slate-50 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={ loading || searching }
                className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-70"
              >
                <Sparkles className="w-4 h-4" />
                { searching ? "Searching..." : "Semantic search" }
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Filter className="w-4 h-4" /> Sections
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  { SECTION_OPTIONS.map( ( option ) => {
                    const isActive = filters.sections.includes( option.key );
                    return (
                      <button
                        key={ option.key }
                        type="button"
                        onClick={ () => handleSectionToggle( option.key ) }
                        className={ `px-3 py-1 rounded-full text-sm border transition ${
                          isActive
                            ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                            : "bg-white text-slate-700 border-slate-200 hover:border-slate-300"
                        }` }
                      >
                        { option.label }
                      </button>
                    );
                  } ) }
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-slate-800">Date range</p>
                <div className="flex gap-2 mt-2">
                  <input
                    type="date"
                    value={ filters.startDate }
                    onChange={ ( e ) => setFilters( ( prev ) => ( { ...prev, startDate: e.target.value } ) ) }
                    className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="date"
                    value={ filters.endDate }
                    onChange={ ( e ) => setFilters( ( prev ) => ( { ...prev, endDate: e.target.value } ) ) }
                    className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                <p className="text-sm font-semibold text-slate-800">Volume & session</p>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={ filters.volumeNumber }
                    placeholder="Volume"
                    onChange={ ( e ) => setFilters( ( prev ) => ( { ...prev, volumeNumber: e.target.value } ) ) }
                    className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="number"
                    value={ filters.sessionNumber }
                    placeholder="Session"
                    onChange={ ( e ) => setFilters( ( prev ) => ( { ...prev, sessionNumber: e.target.value } ) ) }
                    className="w-full px-3 py-2 rounded-md border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={ filters.hasSummaryOnly }
                    onChange={ ( e ) => setFilters( ( prev ) => ( { ...prev, hasSummaryOnly: e.target.checked } ) ) }
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  Only show saved summaries
                </label>
              </div>
            </div>

            { hasActiveFilters && (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <Sparkles className="w-4 h-4 text-blue-600" />
                Filters applied. Adjust any field to refresh the feed automatically.
              </div>
            ) }
          </form>
        </section>

        { loading ? (
          <p className="text-center text-slate-600 font-semibold mt-6">Loading search results…</p>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 mt-0.5" />
            <div>
              <p className="font-semibold">Something went wrong</p>
              <p className="text-sm">{ error }</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm text-slate-600">
              <p>
                Showing { records.length } result{ records.length === 1 ? "" : "s" }
                { activeQuery ? ` for “${ activeQuery }”` : "" }
              </p>
              { activeQuery && <p className="text-blue-700 font-medium">Semantic search enabled</p> }
            </div>

            { records.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-600">
                <p className="font-semibold text-slate-800 mb-1">No reports match that search.</p>
                <p className="text-sm">Try removing a filter or searching for a broader topic.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                { records.map( ( record ) => {
                  const pdfUrl = record.pdfUrl || record.url;
                  return (
                    <div key={ record.id || record.issueNumber } className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-500">Issue { record.issueNumber }</p>
                          <h2 className="text-lg font-semibold text-slate-900">Vol. { record.volumeNumber }</h2>
                          <div className="flex items-center gap-2 text-sm text-slate-600 mt-1">
                            <Calendar className="w-4 h-4" />
                            <span>{ formatIssueDate( record.issueDate ) }</span>
                          </div>
                        </div>
                        { record.similarity !== undefined && record.similarity !== null && (
                          <div className="text-right">
                            <p className="text-xs text-slate-500">Match</p>
                            <p className="text-sm font-semibold text-blue-700">
                              { ( record.similarity * 100 ).toFixed( 1 ) }%
                            </p>
                          </div>
                        ) }
                      </div>

                      <div className="flex flex-wrap gap-2">
                        { record.sections?.map( ( section ) => (
                          <a
                            key={ `${ record.id }-${ section.key }` }
                            href={ section.url }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-3 py-1 text-xs rounded-full bg-blue-50 text-blue-800 border border-blue-100 hover:bg-blue-100 transition"
                          >
                            <FileText className="w-3 h-3" /> { section.label }
                          </a>
                        ) ) }
                      </div>

                      <div className="text-sm text-slate-700 leading-6 border-t border-slate-100 pt-3 min-h-[90px]">
                        { renderHighlighted( record.summaryPreview ) }
                      </div>

                      <div className="flex items-center gap-3 pt-2">
                        <a
                          href={ pdfUrl }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-700 font-semibold text-sm hover:underline"
                        >
                          View PDF <ExternalLink className="w-4 h-4" />
                        </a>
                        <button
                          onClick={ () => summarizePdf( pdfUrl, record.issueNumber ) }
                          className="text-sm font-semibold inline-flex items-center gap-1 text-green-700 hover:underline disabled:opacity-60"
                          disabled={ loadingSummaries[ record.issueNumber ] }
                        >
                          { loadingSummaries[ record.issueNumber ] ? "Summarizing..." : "View summary" }
                        </button>
                      </div>
                    </div>
                  );
                } ) }
              </div>
            ) }
          </>
        ) }
      </main>

      { selectedSummary && (
        <div className="inset-0 fixed bg-black/70 flex items-center justify-center px-4 py-8 z-10">
          <div className="bg-white p-6 rounded-xl w-full max-w-4xl shadow-xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-slate-900">Summary</h2>
              <button onClick={ () => setSelectedSummary( null ) } className="text-sm text-slate-600 hover:text-slate-900">
                Close
              </button>
            </div>
            <p className="text-slate-800 text-base leading-7 whitespace-pre-wrap">{ selectedSummary }</p>
          </div>
        </div>
      ) }
    </div>
  );
}
