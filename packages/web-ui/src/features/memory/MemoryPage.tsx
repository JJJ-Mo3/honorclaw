import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface Agent {
  id: string;
  name: string;
  model: string;
  status: string;
}

interface Document {
  source_name: string;
  source_hash: string;
  chunk_count: number;
  ingested_at: string;
}

interface SearchResult {
  content: string;
  source_name: string;
  similarity: number;
}

export function MemoryPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  // Load agents on mount
  useEffect(() => {
    async function loadAgents() {
      try {
        const data = await api.get<{ agents: Agent[] }>('/agents');
        setAgents(data.agents);
        if (data.agents.length > 0) {
          setSelectedAgent(data.agents[0]!.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load agents');
      } finally {
        setLoading(false);
      }
    }
    void loadAgents();
  }, []);

  // Load documents when agent changes
  const loadDocuments = useCallback(async () => {
    if (!selectedAgent) return;
    try {
      setError('');
      const data = await api.get<{ documents: Document[] }>(`/agents/${selectedAgent}/memory/documents`);
      setDocuments(data.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    }
  }, [selectedAgent]);

  useEffect(() => {
    void loadDocuments();
    setSearchResults([]);
    setSearchQuery('');
  }, [loadDocuments]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent || !searchQuery.trim()) return;
    try {
      setSearching(true);
      setError('');
      const data = await api.post<{ results: SearchResult[] }>(`/agents/${selectedAgent}/memory/search`, {
        query: searchQuery,
        limit: 10,
      });
      setSearchResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleReingest = async (sourceHash: string) => {
    if (!selectedAgent) return;
    try {
      setError('');
      await api.post(`/agents/${selectedAgent}/memory/documents/${sourceHash}/reingest`);
      void loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-ingest document');
    }
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-bold mb-6">Memory & Documents</h1>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Select Agent</label>
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          className="border border-gray-300 rounded px-3 py-2 text-sm w-full max-w-md"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({a.model})</option>
          ))}
        </select>
      </div>

      {selectedAgent && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Documents panel */}
          <div>
            <h2 className="text-lg font-semibold mb-3">Indexed Documents</h2>
            {documents.length === 0 ? (
              <p className="text-sm text-gray-500">No documents ingested for this agent.</p>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div key={doc.source_hash} className="bg-white rounded-lg border border-gray-200 p-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-medium text-sm">{doc.source_name}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {doc.chunk_count} chunks | Ingested: {new Date(doc.ingested_at).toLocaleString()}
                        </p>
                      </div>
                      <button
                        onClick={() => { void handleReingest(doc.source_hash); }}
                        className="text-xs text-blue-600 hover:text-blue-800 shrink-0"
                      >
                        Re-ingest
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search panel */}
          <div>
            <h2 className="text-lg font-semibold mb-3">Semantic Search</h2>
            <form onSubmit={(e) => { void handleSearch(e); }} className="mb-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search agent memory..."
                  className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={searching || !searchQuery.trim()}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </div>
            </form>

            {searchResults.length > 0 && (
              <div className="space-y-2">
                {searchResults.map((r, i) => (
                  <div key={i} className="bg-white rounded-lg border border-gray-200 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{r.source_name}</span>
                      <span className="text-xs text-blue-600">
                        {(r.similarity * 100).toFixed(1)}% match
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
