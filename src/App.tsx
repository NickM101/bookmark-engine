import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { initializeDatabase, getDatabase } from "@/lib/db";
import { importBookmarks, type ImportResult } from "@/lib/importer";
import {
  searchBookmarks,
  semanticSearch,
  getRecentBookmarks,
  getAllFolders,
  getFolderTree,
  getFolderBookmarks,
  getUnprocessedCount,
  clearDatabase,
  type Bookmark,
  type Folder,
  type FolderNode,
} from "@/lib/api";
import { startProcessingQueue, type QueueStats } from "@/lib/processor";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Search,
  FileText,
  Folder as FolderIcon,
  Upload,
  Globe,
  ExternalLink,
  Clock,
  Bookmark as BookmarkIcon,
  Loader2,
  FolderTree,
  Database,
  X,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Trash2,
  Settings,
  Sparkles,
  KeyRound,
  Eye,
  EyeOff,
  Play,
  Pause,
} from "lucide-react";

/**
 * Custom hook to debounce any fast-changing value by a given delay in milliseconds.
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default function App() {
  const queryClient = useQueryClient();

  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  // Search state with 300ms debounce
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearchQuery = useDebounce(searchInput, 300);
  const [searchMode, setSearchMode] = useState<"fts" | "semantic">("fts");

  // API Key & Settings state
  const [apiKey, setApiKey] = useState<string>(
    () => localStorage.getItem("gemini_api_key") || ""
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsKeyInput, setSettingsKeyInput] = useState(apiKey);
  const [showApiKey, setShowApiKey] = useState(false);

  // File import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importNotification, setImportNotification] = useState<{
    result?: ImportResult;
    error?: string;
  } | null>(null);

  // Initialize SQLite database
  useEffect(() => {
    initializeDatabase()
      .then(() => setDbReady(true))
      .catch((err) => {
        console.error("Database initialization failed:", err);
        setDbError(String(err));
      });
  }, []);

  // Active selection: null = All Bookmarks, 'recent' = Recent, or folderId
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());

  // Toggle tree expansion
  function toggleFolderExpanded(folderId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  // Fetch folders tree with counts for hierarchical sidebar
  const { data: folderTree = [] } = useQuery<FolderNode[]>({
    queryKey: ["folderTree"],
    queryFn: async () => getFolderTree(),
    enabled: dbReady,
  });

  // Flat folders list for breadcrumb / lookup
  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ["folders"],
    queryFn: async () => getAllFolders(),
    enabled: dbReady,
  });

  const selectedFolder = selectedFolderId
    ? folders.find((f) => f.id === selectedFolderId)
    : null;

  // Build breadcrumb trail for selected folder to disambiguate identical folder names
  const folderBreadcrumbs = (() => {
    if (!selectedFolder) return [];
    const crumbs: Folder[] = [];
    let cur: Folder | undefined = selectedFolder;
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      crumbs.unshift(cur);
      cur = cur.parent_id ? folders.find((f) => f.id === cur!.parent_id) : undefined;
    }
    return crumbs;
  })();

  // Query count of unprocessed bookmarks pending AI classification/embeddings
  const { data: unprocessedCount = 0 } = useQuery<number>({
    queryKey: ["unprocessedCount"],
    queryFn: async () => getUnprocessedCount(),
    enabled: dbReady,
  });

  // Fetch bookmarks using TanStack Query based on debounced search query, search mode, or folder
  const {
    data: bookmarks = [],
    isLoading: isBookmarksLoading,
    isFetching: isBookmarksFetching,
  } = useQuery<Bookmark[]>({
    queryKey: [
      "bookmarks",
      debouncedSearchQuery,
      searchMode,
      selectedFolderId,
      apiKey,
    ],
    queryFn: async () => {
      const query = debouncedSearchQuery.trim();
      if (query) {
        if (searchMode === "semantic") {
          if (!apiKey.trim()) {
            return [];
          }
          return semanticSearch(query, apiKey.trim());
        }
        return searchBookmarks(query);
      }
      if (selectedFolderId === "recent") {
        return getRecentBookmarks(50);
      }
      if (selectedFolderId) {
        return getFolderBookmarks(selectedFolderId, true);
      }
      // Default: All recent bookmarks
      return getRecentBookmarks(100);
    },
    enabled: dbReady,
  });

  // Fetch stats for the sidebar footer
  const { data: bookmarkCount = 0 } = useQuery<number>({
    queryKey: ["bookmarkCount"],
    queryFn: async () => {
      const db = await getDatabase();
      const res = await db.select<{ count: number }[]>(
        "SELECT COUNT(*) as count FROM bookmarks"
      );
      return res[0]?.count ?? 0;
    },
    enabled: dbReady,
  });

  // Background AI processing queue state
  const [queueStats, setQueueStats] = useState<QueueStats>({
    status: "idle",
    processed: 0,
    total: 0,
    failed: 0,
  });
  const abortQueueRef = useRef<(() => void) | null>(null);

  const isIndexing =
    queueStats.status === "running" || queueStats.status === "backing_off";

  // Real-time TanStack Query cache invalidation when bookmarks are classified
  useEffect(() => {
    const handleBookmarkAiUpdated = () => {
      queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      queryClient.invalidateQueries({ queryKey: ["unprocessedCount"] });
    };

    window.addEventListener("bookmark-ai-updated", handleBookmarkAiUpdated);
    return () => {
      window.removeEventListener("bookmark-ai-updated", handleBookmarkAiUpdated);
    };
  }, [queryClient]);

  // Clean suspension on window close or component unmount to prevent dangling promises or corrupted state
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (abortQueueRef.current) {
        abortQueueRef.current();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (abortQueueRef.current) {
        abortQueueRef.current();
        abortQueueRef.current = null;
      }
    };
  }, []);

  // Play / Pause toggle for the automated background queue
  function handleToggleIndexing() {
    if (isIndexing) {
      if (abortQueueRef.current) {
        abortQueueRef.current();
        abortQueueRef.current = null;
      }
      toast.info("AI indexing paused");
    } else {
      if (!apiKey.trim()) {
        toast.error("Gemini API Key Required", {
          description: "Please configure your Gemini API key in Settings first.",
        });
        setSettingsKeyInput(apiKey);
        setIsSettingsOpen(true);
        return;
      }

      const abort = startProcessingQueue(apiKey.trim(), (stats) => {
        setQueueStats(stats);
        if (stats.status === "completed") {
          abortQueueRef.current = null;
          toast.success("AI indexing completed!", {
            description: `Successfully processed ${stats.processed} bookmarks.`,
          });
          queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
          queryClient.invalidateQueries({ queryKey: ["unprocessedCount"] });
        }
      });

      abortQueueRef.current = abort;
      toast.info("AI indexing started", {
        description: "Background queue is processing bookmarks (concurrency: 2).",
      });
    }
  }

  // Save Settings handler
  function handleSaveSettings(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = settingsKeyInput.trim();
    localStorage.setItem("gemini_api_key", trimmed);
    setApiKey(trimmed);
    setIsSettingsOpen(false);
    toast.success("Settings saved", {
      description: trimmed
        ? "Gemini API key updated."
        : "Gemini API key removed.",
    });
    queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
  }

  // Open bookmark externally in the default system browser via plugin-shell or plugin-opener
  async function handleOpenBookmark(url: string) {
    if (!url) return;
    try {
      await openExternalUrl(url);
    } catch (shellErr) {
      console.warn("Shell open failed, trying plugin-opener:", shellErr);
      try {
        await openUrl(url);
      } catch (openerErr) {
        console.error("Failed to open URL:", openerErr);
        toast.error("Could not open URL in external browser", {
          description: url,
        });
      }
    }
  }

  // Handle Netscape HTML import
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportNotification(null);

    const toastId = toast.loading(`Importing "${file.name}"...`, {
      description: "Reading HTML file...",
    });

    try {
      const text = await file.text();
      const res = await importBookmarks(text, (progress) => {
        toast.loading(progress.message, {
          id: toastId,
          description: `${progress.percent}% complete`,
        });
      });

      setImportNotification({ result: res });

      toast.success("Bookmark import complete!", {
        id: toastId,
        description: `Ingested ${res.bookmarksInserted} bookmarks and ${res.foldersCreated} folders${
          res.duplicatesIgnored > 0 ? ` (${res.duplicatesIgnored} duplicates skipped)` : ""
        }.`,
        duration: 4000,
      });

      // Invalidate queries so results immediately refresh
      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      await queryClient.invalidateQueries({ queryKey: ["folders"] });
      await queryClient.invalidateQueries({ queryKey: ["folderTree"] });
      await queryClient.invalidateQueries({ queryKey: ["bookmarkCount"] });
      await queryClient.invalidateQueries({ queryKey: ["unprocessedCount"] });
    } catch (err) {
      console.error("Import error:", err);
      setImportNotification({ error: String(err) });
      toast.error("Import failed", {
        id: toastId,
        description: String(err),
        duration: 5000,
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  // Handle wiping all database tables
  async function handleClearDatabase() {
    if (!window.confirm("Are you sure you want to clear all bookmarks and folders?")) {
      return;
    }
    try {
      await clearDatabase();
      setSelectedFolderId(null);
      setImportNotification(null);
      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      await queryClient.invalidateQueries({ queryKey: ["folders"] });
      await queryClient.invalidateQueries({ queryKey: ["folderTree"] });
      await queryClient.invalidateQueries({ queryKey: ["bookmarkCount"] });
      await queryClient.invalidateQueries({ queryKey: ["unprocessedCount"] });
      toast.success("Database cleared successfully", { duration: 3000 });
    } catch (err) {
      console.error("Failed to clear database:", err);
      toast.error("Failed to clear database: " + String(err));
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground antialiased selection:bg-primary/20">
      {/* Toast provider */}
      <Toaster position="bottom-right" richColors closeButton />

      {/* Hidden file input for Netscape Bookmark HTML imports */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".html,.htm"
        className="hidden"
        onChange={handleFileUpload}
      />

      {/* Settings Dialog */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="size-5 text-primary" />
              Settings
            </DialogTitle>
            <DialogDescription>
              Configure your Google Gemini API key to enable AI categorization, summaries, and semantic vector search.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveSettings} className="space-y-4 py-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                <label htmlFor="gemini-key">Google Gemini API Key</label>
                <button
                  type="button"
                  onClick={() => handleOpenBookmark("https://aistudio.google.com/app/apikey")}
                  className="inline-flex items-center gap-1 font-normal text-[11px] text-primary hover:underline cursor-pointer"
                >
                  Get free key <ExternalLink className="size-3" />
                </button>
              </div>

              <div className="relative">
                <Input
                  id="gemini-key"
                  type={showApiKey ? "text" : "password"}
                  placeholder="AIzaSy..."
                  value={settingsKeyInput}
                  onChange={(e) => setSettingsKeyInput(e.target.value)}
                  className="pr-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                  title={showApiKey ? "Hide key" : "Show key"}
                >
                  {showApiKey ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </button>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Your key is stored strictly on this device in your browser's local storage and is never sent to external servers other than Google's Gemini API endpoints.
              </p>
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2">
              {apiKey && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    localStorage.removeItem("gemini_api_key");
                    setApiKey("");
                    setSettingsKeyInput("");
                    toast.info("Gemini API Key removed.");
                    queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
                  }}
                  className="text-xs text-destructive hover:text-destructive cursor-pointer mr-auto"
                >
                  Remove Key
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsSettingsOpen(false)}
                className="text-xs cursor-pointer"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" className="text-xs cursor-pointer">
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 1. Persistent Top Search Bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/60 px-4 backdrop-blur-md">
        {/* Brand / Logo */}
        <div className="flex items-center gap-2.5 w-52 shrink-0">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <BookmarkIcon className="size-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight leading-none">
              Bookmarks
            </h1>
            <span className="text-[10px] text-muted-foreground font-mono">
              Desktop Engine
            </span>
          </div>
        </div>

        {/* Search input with 300ms debounce and Mode Toggle */}
        <div className="flex items-center gap-2 flex-1 max-w-2xl mx-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              placeholder={
                searchMode === "semantic"
                  ? "Semantic search by concepts, libraries, technologies..."
                  : "Search bookmarks by title, URL, or description..."
              }
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              disabled={!dbReady}
              className="w-full pl-9 pr-9 h-9 bg-background/80 rounded-lg border-input/80 text-sm focus-visible:ring-1 focus-visible:ring-primary shadow-xs"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Search Mode Toggle (FTS vs Semantic) */}
          <div className="inline-flex h-9 shrink-0 items-center rounded-lg border border-border bg-muted/40 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setSearchMode("fts")}
              className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                searchMode === "fts"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Full-Text Keyword Search (FTS5)"
            >
              FTS
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchMode("semantic");
                if (!apiKey.trim()) {
                  toast.info("Gemini API key is required for Semantic Search", {
                    action: {
                      label: "Settings",
                      onClick: () => {
                        setSettingsKeyInput(apiKey);
                        setIsSettingsOpen(true);
                      },
                    },
                  });
                }
              }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                searchMode === "semantic"
                  ? "bg-primary text-primary-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Vector Semantic Search (Gemini text-embedding-004)"
            >
              <Sparkles className="size-3" />
              Semantic
            </button>
          </div>
        </div>

        {/* Top actions & Status */}
        <div className="flex items-center gap-2 shrink-0">
          {isBookmarksFetching && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}

          {/* Start AI Indexing / Pause Queue Toggle Button */}
          <Button
            variant={isIndexing ? "secondary" : "outline"}
            size="sm"
            onClick={handleToggleIndexing}
            disabled={!dbReady || isImporting}
            title={
              isIndexing
                ? queueStats.status === "backing_off"
                  ? `Rate limited: backing off for ${queueStats.backoffSecondsRemaining ?? 10}s. Click to pause.`
                  : "Pause AI background indexing queue"
                : unprocessedCount > 0
                ? `Start background AI indexing (${unprocessedCount} pending)`
                : "All bookmarks processed with AI"
            }
            className={`h-8 gap-1.5 text-xs font-medium cursor-pointer transition-all ${
              isIndexing
                ? queueStats.status === "backing_off"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "border-primary/30 bg-primary/10 text-primary"
                : ""
            }`}
          >
            {isIndexing ? (
              queueStats.status === "backing_off" ? (
                <>
                  <Clock className="size-3.5 animate-pulse text-amber-500" />
                  <span>Pause ({queueStats.backoffSecondsRemaining ?? 10}s)</span>
                </>
              ) : (
                <>
                  <Pause className="size-3.5 fill-current text-primary" />
                  <span>Pause</span>
                </>
              )
            ) : (
              <>
                <Play className="size-3.5 fill-current text-amber-500" />
                <span>Start AI Indexing</span>
                {unprocessedCount > 0 && (
                  <span className="ml-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.2 text-[10px] font-mono font-semibold text-amber-600 dark:text-amber-400">
                    {unprocessedCount}
                  </span>
                )}
              </>
            )}
          </Button>

          {/* Import HTML */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!dbReady || isImporting}
            className="h-8 gap-1.5 text-xs font-medium cursor-pointer"
          >
            {isImporting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Importing...
              </>
            ) : (
              <>
                <Upload className="size-3.5" />
                Import HTML
              </>
            )}
          </Button>

          {/* Settings Dialog Trigger */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSettingsKeyInput(apiKey);
              setIsSettingsOpen(true);
            }}
            title="Application Settings (Gemini API Key)"
            className="h-8 gap-1.5 text-xs font-medium cursor-pointer"
          >
            <Settings className="size-3.5" />
            <span className="hidden lg:inline">Settings</span>
          </Button>

          {/* Database Reset */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearDatabase}
            disabled={!dbReady || isImporting}
            title="Reset / Clear all database records"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive cursor-pointer"
          >
            <Trash2 className="size-3.5" />
          </Button>

          {/* SQLite Status Dot */}
          <div
            title={
              dbReady
                ? "SQLite Database Connected"
                : dbError || "Connecting to Database..."
            }
            className="flex items-center gap-1.5 pl-1"
          >
            <span
              className={`size-2 rounded-full ${
                dbReady
                  ? "bg-emerald-500 ring-2 ring-emerald-500/20"
                  : dbError
                  ? "bg-destructive ring-2 ring-destructive/20"
                  : "bg-amber-500 animate-pulse"
              }`}
            />
          </div>
        </div>
      </header>

      {/* Live AI Indexing Progress Bar */}
      {queueStats.status !== "idle" && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 border-b border-border bg-card/60 px-4 py-2 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Status indicator badge */}
            <div className="flex items-center gap-1.5 shrink-0">
              {queueStats.status === "running" && (
                <span className="flex items-center gap-1.5 font-semibold text-primary">
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  Indexing (2 workers)
                </span>
              )}
              {queueStats.status === "backing_off" && (
                <span className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                  <Clock className="size-3.5 animate-pulse" />
                  Rate Limited (Retrying in {queueStats.backoffSecondsRemaining ?? 10}s)
                </span>
              )}
              {queueStats.status === "paused" && (
                <span className="flex items-center gap-1.5 font-semibold text-muted-foreground">
                  <Pause className="size-3.5 fill-current" />
                  Indexing Paused
                </span>
              )}
              {queueStats.status === "completed" && (
                <span className="flex items-center gap-1.5 font-semibold text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  Indexing Complete
                </span>
              )}
            </div>

            {/* Current URL indicator */}
            {queueStats.currentUrl && isIndexing && (
              <span className="truncate max-w-sm md:max-w-md lg:max-w-lg text-[11px] font-mono text-muted-foreground">
                Processing: {queueStats.currentUrl}
              </span>
            )}
          </div>

          {/* Progress Bar & Numeric stats */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-xs font-medium text-foreground">
              Processed {queueStats.processed} / Total {queueStats.total}
              {queueStats.failed > 0 && (
                <span className="text-muted-foreground ml-1 text-[11px]">
                  ({queueStats.failed} unreachable)
                </span>
              )}
            </span>

            <div className="w-24 sm:w-36 h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all duration-300 rounded-full ${
                  queueStats.status === "backing_off"
                    ? "bg-amber-500"
                    : queueStats.status === "completed"
                    ? "bg-emerald-500"
                    : "bg-primary"
                }`}
                style={{
                  width: `${
                    queueStats.total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            ((queueStats.processed + queueStats.failed) /
                              queueStats.total) *
                              100
                          )
                        )
                      : queueStats.status === "completed"
                      ? 100
                      : 0
                  }%`,
                }}
              />
            </div>

            {(queueStats.status === "completed" || queueStats.status === "paused") && (
              <button
                type="button"
                onClick={() =>
                  setQueueStats({
                    status: "idle",
                    processed: 0,
                    total: 0,
                    failed: 0,
                  })
                }
                className="text-muted-foreground hover:text-foreground cursor-pointer p-0.5"
                title="Dismiss progress bar"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Import Notification Banner */}
      {importNotification?.result && (
        <div className="flex items-center justify-between bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4" />
            <span>
              Successfully ingested {importNotification.result.bookmarksInserted} bookmarks
              and {importNotification.result.foldersCreated} folders
              {importNotification.result.duplicatesIgnored > 0 &&
                ` (${importNotification.result.duplicatesIgnored} duplicates ignored)`}
              .
            </span>
          </div>
          <button
            type="button"
            onClick={() => setImportNotification(null)}
            className="text-emerald-700 dark:text-emerald-400 hover:opacity-75 cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {importNotification?.error && (
        <div className="flex items-center justify-between bg-destructive/10 border-b border-destructive/20 px-4 py-2 text-xs text-destructive">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4" />
            <span>Import failed: {importNotification.error}</span>
          </div>
          <button
            type="button"
            onClick={() => setImportNotification(null)}
            className="hover:opacity-75 cursor-pointer"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* 2. Desktop Body: Left Sidebar + Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Sidebar for categories / folders (hierarchical navigation) */}
        <aside className="flex w-64 shrink-0 flex-col justify-between border-r border-border bg-card/30 min-h-0 h-full overflow-hidden">
          <ScrollArea className="flex-1 min-h-0 h-full py-3 px-2">
            <div className="space-y-4">
              {/* Navigation groups */}
              <div className="space-y-1">
                <div className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Library
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFolderId(null);
                    setSearchInput("");
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors text-left cursor-pointer ${
                    selectedFolderId === null && !debouncedSearchQuery.trim()
                      ? "bg-primary/10 text-primary font-semibold"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <BookmarkIcon className="size-3.5 shrink-0" />
                    <span>All Bookmarks</span>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {bookmarkCount.toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFolderId("recent");
                    setSearchInput("");
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors text-left cursor-pointer ${
                    selectedFolderId === "recent" && !debouncedSearchQuery.trim()
                      ? "bg-primary/10 text-primary font-semibold"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  <Clock className="size-3.5 shrink-0" />
                  <span>Recent</span>
                </button>
              </div>

              {/* Categories & Folders (Hierarchical Interactive Tree) */}
              <div className="space-y-1">
                <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  <span>Folders</span>
                  <span className="text-[10px] font-mono">{folders.length}</span>
                </div>

                {folderTree.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground/70">
                    <FolderTree className="mx-auto size-5 mb-1 opacity-40" />
                    <span>No folders imported</span>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {/* Recursive tree item renderer */}
                    {(() => {
                      function renderTreeNode(node: FolderNode, depth: number = 0) {
                        const isExpanded = expandedFolderIds.has(node.id);
                        const isSelected = selectedFolderId === node.id;
                        const hasChildren = node.children.length > 0;

                        return (
                          <div key={node.id} className="flex flex-col">
                            <div
                              onClick={() => {
                                setSelectedFolderId(node.id);
                                setSearchInput("");
                                if (hasChildren && !isExpanded) {
                                  setExpandedFolderIds((prev) => new Set(prev).add(node.id));
                                }
                              }}
                              className={`group flex w-full items-center justify-between rounded-md py-1.5 pr-2 text-xs transition-colors cursor-pointer select-none ${
                                isSelected && !debouncedSearchQuery.trim()
                                  ? "bg-primary/10 text-primary font-medium"
                                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                              }`}
                              style={{ paddingLeft: `${depth * 12 + 6}px` }}
                            >
                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    onClick={(e) => toggleFolderExpanded(node.id, e)}
                                    className="p-0.5 -ml-1 rounded hover:bg-muted text-muted-foreground/80 hover:text-foreground transition-colors"
                                  >
                                    {isExpanded ? (
                                      <ChevronDown className="size-3.5" />
                                    ) : (
                                      <ChevronRight className="size-3.5" />
                                    )}
                                  </button>
                                ) : (
                                  <span className="size-3.5 shrink-0" />
                                )}

                                {isSelected ? (
                                  <FolderOpen className="size-3.5 shrink-0 text-primary" />
                                ) : (
                                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70 group-hover:text-primary transition-colors" />
                                )}

                                <span className="truncate">{node.name}</span>
                              </div>

                              {(node.bookmarkCount ?? 0) > 0 && (
                                <span className="ml-1 text-[10px] font-mono text-muted-foreground/60 group-hover:text-muted-foreground">
                                  {node.bookmarkCount}
                                </span>
                              )}
                            </div>

                            {/* Render children recursively if expanded */}
                            {hasChildren && isExpanded && (
                              <div className="flex flex-col">
                                {node.children.map((child) =>
                                  renderTreeNode(child, depth + 1)
                                )}
                              </div>
                            )}
                          </div>
                        );
                      }

                      return folderTree.map((rootNode) => renderTreeNode(rootNode, 0));
                    })()}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          {/* Sidebar Footer: SQLite & AI status */}
          <div className="border-t border-border/60 p-3 bg-muted/10 shrink-0 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Database className="size-3" />
                SQLite Store
              </span>
              <span className="font-mono font-medium">
                {bookmarkCount.toLocaleString()} items
              </span>
            </div>
            {unprocessedCount > 0 && (
              <div className="flex items-center justify-between text-[10px] text-amber-600 dark:text-amber-400">
                <span className="flex items-center gap-1">
                  <Sparkles className="size-2.5" />
                  Pending AI
                </span>
                <span className="font-mono">{unprocessedCount}</span>
              </div>
            )}
          </div>
        </aside>

        {/* 3. Main Content Area */}
        <main className="flex flex-1 flex-col overflow-hidden min-h-0 h-full bg-background">
          {/* Main Content Header */}
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-6 bg-card/20">
            <div className="flex items-center gap-2 overflow-hidden mr-4">
              {debouncedSearchQuery.trim() ? (
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {searchMode === "semantic" ? "Semantic Search" : "FTS Search"}:
                  </span>
                  <span className="text-xs font-medium text-foreground truncate">
                    "{debouncedSearchQuery}"
                  </span>
                  {searchMode === "semantic" && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1.5 py-0.2 text-[10px] font-medium shrink-0">
                      <Sparkles className="size-2.5" />
                      Vector
                    </span>
                  )}
                </div>
              ) : selectedFolder ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                  <span
                    onClick={() => setSelectedFolderId(null)}
                    className="hover:text-foreground cursor-pointer transition-colors"
                  >
                    Library
                  </span>
                  {folderBreadcrumbs.map((crumb, idx) => {
                    const isLast = idx === folderBreadcrumbs.length - 1;
                    return (
                      <span key={crumb.id} className="inline-flex items-center gap-1.5 truncate">
                        <ChevronRight className="size-3 opacity-40 shrink-0" />
                        <span
                          onClick={() => setSelectedFolderId(crumb.id)}
                          className={`truncate cursor-pointer hover:text-foreground transition-colors ${
                            isLast ? "font-semibold text-foreground" : ""
                          }`}
                        >
                          {crumb.name}
                        </span>
                      </span>
                    );
                  })}
                </div>
              ) : selectedFolderId === "recent" ? (
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent Bookmarks
                </h2>
              ) : (
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  All Bookmarks
                </h2>
              )}
            </div>
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {bookmarks.length} {bookmarks.length === 1 ? "item" : "items"}
            </span>
          </div>

          {/* 4. Bookmark Vertical List with ScrollArea */}
          <ScrollArea className="flex-1 min-h-0 h-full">
            <div className="p-6">
              {/* Semantic search requires API key warning constraint */}
              {searchMode === "semantic" && debouncedSearchQuery.trim() && !apiKey.trim() ? (
                <div className="flex flex-col items-center justify-center py-20 px-4 text-center max-w-md mx-auto">
                  <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 mb-3">
                    <KeyRound className="size-6" />
                  </div>
                  <h3 className="text-base font-semibold">Gemini API Key Required</h3>
                  <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                    Semantic search computes vector embeddings for your query and matches against stored bookmark vectors. Please add your Google Gemini API key in Settings to activate semantic search.
                  </p>
                  <Button
                    onClick={() => {
                      setSettingsKeyInput(apiKey);
                      setIsSettingsOpen(true);
                    }}
                    className="mt-4 gap-1.5 text-xs cursor-pointer"
                    size="sm"
                  >
                    <Settings className="size-3.5" />
                    Open Settings
                  </Button>
                </div>
              ) : isBookmarksLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
                  <Loader2 className="size-6 animate-spin text-primary" />
                  <p className="text-xs">
                    {searchMode === "semantic"
                      ? "Computing query vector & searching embeddings..."
                      : "Loading bookmarks..."}
                  </p>
                </div>
              ) : bookmarks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="flex size-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground mb-3">
                    <Search className="size-5" />
                  </div>
                  <h3 className="text-sm font-semibold">No bookmarks found</h3>
                  <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                    {debouncedSearchQuery.trim()
                      ? searchMode === "semantic"
                        ? `No matching bookmarks found for "${debouncedSearchQuery}". Try processing more bookmarks with the "Process AI" button or adjusting your query.`
                        : `No bookmarks match "${debouncedSearchQuery}". Try another keyword or check for spelling.`
                      : "Your library is empty. Click 'Import HTML' in the top bar to ingest your exported browser bookmarks."}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {bookmarks.map((bookmark) => {
                    const category = bookmark.ai?.category || bookmark.ai_category;
                    const displaySummary = bookmark.ai?.summary || bookmark.ai_summary;
                    const similarityScore = bookmark.similarityScore;

                    return (
                      <div
                        key={bookmark.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleOpenBookmark(bookmark.url)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleOpenBookmark(bookmark.url);
                          }
                        }}
                        className="group flex items-start gap-3.5 rounded-lg border border-border/40 bg-card/40 p-3 hover:bg-accent/40 hover:border-border transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-xs"
                      >
                        {/* Generic File Icon */}
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors mt-0.5">
                          <FileText className="size-4" />
                        </div>

                        {/* Bookmark Content */}
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="text-sm font-medium leading-snug text-foreground group-hover:text-primary transition-colors truncate">
                              {bookmark.title || bookmark.url}
                            </h4>

                            {/* Badges container */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              {/* Category Badge from bookmarkAi */}
                              {category && (
                                <span className="inline-flex items-center gap-1 rounded bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  <Sparkles className="size-2.5 text-primary" />
                                  {category}
                                </span>
                              )}

                              {/* Semantic match percentage */}
                              {typeof similarityScore === "number" && (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                                  {Math.max(0, Math.round(similarityScore * 100))}% match
                                </span>
                              )}

                              {/* Domain Badge */}
                              {bookmark.domain && (
                                <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                                  <Globe className="size-2.5 opacity-60" />
                                  {bookmark.domain}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* AI Summary (preferred) or Description Snippet */}
                          {displaySummary ? (
                            <p className="text-xs text-foreground/90 line-clamp-2 leading-relaxed flex items-start gap-1.5">
                              <Sparkles className="size-3 text-amber-500 shrink-0 mt-0.5" />
                              <span>{displaySummary}</span>
                            </p>
                          ) : bookmark.description ? (
                            <p className="text-xs text-muted-foreground/80 line-clamp-1 leading-relaxed">
                              {bookmark.description}
                            </p>
                          ) : null}

                          {/* URL and Open icon */}
                          <div className="flex items-center gap-1 text-[11px] text-muted-foreground/70 font-mono truncate">
                            <span className="truncate">{bookmark.url}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ml-1 text-primary" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}
