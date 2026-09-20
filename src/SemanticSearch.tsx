import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import * as api from "./api";
import type { DocumentSession, DocumentSnapshot } from "./documentSession";

interface Results {
  snapshot: DocumentSnapshot;
  source: string;
  response: api.SemanticResults;
}

export function SemanticSearch({
  session,
  inputRef,
  getText,
  onOpen,
}: {
  session: DocumentSession;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  getText: () => string;
  onOpen: (match: api.SemanticMatch, source: string) => void;
}) {
  const document = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [query, setQuery] = useState("");
  const [connection, setConnection] = useState<api.TypeSafeStatus | null>(null);
  const [settings, setSettings] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const connectionRequest = useRef(0);

  const stop = useCallback(() => {
    const active = request.current;
    request.current = null;
    if (active) void api.cancelSemanticSearch(active).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    const load = ++connectionRequest.current;
    inputRef.current?.focus();
    void api
      .typesafeStatus()
      .then((status) => {
        if (active && connectionRequest.current === load) {
          setConnection(status);
          setSettings(!status.configured);
        }
      })
      .catch(() => {
        if (active && connectionRequest.current === load) {
          setSettings(true);
          setError(
            "Could not read Jev settings. Save your API key to try again.",
          );
        }
      });
    return () => {
      active = false;
      stop();
    };
  }, [stop, inputRef]);

  useEffect(() => {
    setNotice(
      request.current || results
        ? "Document changed. Search again for current passages."
        : null,
    );
    stop();
    setBusy(false);
    setResults(null);
    setError(null);
  }, [document.id, document.filePath, document.revision, stop]);

  const current = (snapshot: DocumentSnapshot, source: string) =>
    session.sameDocument(snapshot) &&
    session.getSnapshot().revision === snapshot.revision &&
    getText() === source;

  const find = async () => {
    const description = query.trim();
    if (!description || busy || !connection?.configured) return;
    const source = getText();
    if (!source.trim()) {
      setError("Open or write a document before searching by meaning.");
      return;
    }
    const snapshot = session.getSnapshot();
    const id = crypto.randomUUID();
    stop();
    request.current = id;
    setBusy(true);
    setResults(null);
    setError(null);
    setNotice(null);
    try {
      const response = await api.semanticSearch(source, description, id);
      if (request.current !== id || !current(snapshot, source)) return;
      setResults({ snapshot, source, response });
    } catch (error) {
      if (request.current === id && current(snapshot, source))
        setError(String(error));
    } finally {
      if (request.current === id) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  const saveKey = async (key: string) => {
    ++connectionRequest.current;
    setSavingKey(true);
    setError(null);
    stop();
    setBusy(false);
    setResults(null);
    try {
      const status = await api.writeTypesafeKey(key);
      setConnection(status);
      setApiKey("");
      setSettings(!status.configured);
      inputRef.current?.focus();
    } catch (error) {
      setError(String(error));
    } finally {
      setSavingKey(false);
    }
  };

  const visible =
    results && current(results.snapshot, results.source)
      ? results.response
      : null;
  return (
    <div className="semantic-search">
      <p className="muted">
        Find by meaning in the current document, including unsaved text.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void find();
        }}
      >
        <textarea
          ref={inputRef}
          className="nav-search-input semantic-query"
          aria-label="Describe what to find"
          placeholder="A character avoids answering a question…"
          value={query}
          rows={3}
          spellCheck={false}
          onChange={(event) => {
            stop();
            setBusy(false);
            setQuery(event.target.value);
            setResults(null);
            setNotice(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void find();
            }
          }}
        />
        <div className="semantic-actions">
          <button
            type="submit"
            disabled={
              !connection?.configured || savingKey || busy || !query.trim()
            }
          >
            Find with Jev
          </button>
          {busy ? (
            <button
              type="button"
              onClick={() => {
                stop();
                setBusy(false);
                setNotice("Search cancelled.");
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
      <p className="semantic-provider muted">
        Search sends document passages to TypeSafe.
      </p>
      <button
        className="semantic-settings-toggle"
        onClick={() => setSettings((open) => !open)}
        aria-expanded={settings}
      >
        Jev settings
      </button>
      {settings ? (
        <form
          className="semantic-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey(apiKey);
          }}
        >
          {connection?.from_environment ? (
            <p className="muted">
              Using the TypeSafe key configured for this app environment.
            </p>
          ) : (
            <>
              <label>
                TypeSafe API key
                <input
                  type="password"
                  disabled={savingKey}
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="TypeSafe API key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <p className="muted">Saved privately on this Mac.</p>
              <div className="semantic-actions">
                <button disabled={savingKey || !apiKey.trim()}>Save key</button>
                {connection?.configured ? (
                  <button
                    type="button"
                    disabled={savingKey}
                    onClick={() => void saveKey("")}
                  >
                    Remove key
                  </button>
                ) : null}
              </div>
            </>
          )}
        </form>
      ) : null}
      {busy ? <p role="status">Searching with Jev…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? (
        <p role="status" className="muted">
          {notice}
        </p>
      ) : null}
      {visible ? (
        <>
          <p
            className="nav-search-summary"
            role="status"
            title={`${visible.passages} passages searched in the current document`}
          >
            {visible.matches.length
              ? `${visible.matches.length} suggested passage${visible.matches.length === 1 ? "" : "s"} · best matches first`
              : "No convincing matches found."}
          </p>
          <ul className="nav-search-results semantic-results">
            {visible.matches.map((match) => (
              <li key={match.from}>
                <button
                  className="nav-search-result"
                  title={`Line ${match.line}`}
                  onClick={() => {
                    if (results && current(results.snapshot, results.source))
                      onOpen(match, results.source);
                  }}
                >
                  <span className="nav-search-line">
                    Line {match.line}
                    {match.relevance < 0.8 ? " · Possible match" : ""}
                  </span>
                  <span className="nav-search-preview">{match.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
