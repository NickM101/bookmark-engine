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
  findDuplicateBookmarks,
  deduplicateGroup,
  exportBookmarksToHtml,
  type Bookmark,
  type Folder,
  type FolderNode,
  type DuplicateBookmarkGroup,
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
  DialogTitle,
  DialogDescription,
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
  Pause,
  LayoutGrid,
  List,
  Copy,
  Check,
  Tag,
  Cpu,
  Filter,
  Moon,
  Sun,
  Monitor,
  Info,
  ArrowUpRight,
  BarChart3,
  Download,
  ShieldCheck,
  Command,
  CornerDownLeft,
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

function getCategoryBadgeStyle(category?: string | null): { bg: string; text: string; border: string } {
  if (!category) return { bg: "bg-muted/50", text: "text-muted-foreground", border: "border-border/60" };
  const lower = category.toLowerCase();
  if (lower.includes("ai") || lower.includes("ml") || lower.includes("machine")) {
    return { bg: "bg-purple-500/10", text: "text-purple-600 dark:text-purple-400", border: "border-purple-500/20" };
  }
  if (lower.includes("frontend") || lower.includes("ui") || lower.includes("css") || lower.includes("web")) {
    return { bg: "bg-sky-500/10", text: "text-sky-600 dark:text-sky-400", border: "border-sky-500/20" };
  }
  if (lower.includes("backend") || lower.includes("api") || lower.includes("server")) {
    return { bg: "bg-indigo-500/10", text: "text-indigo-600 dark:text-indigo-400", border: "border-indigo-500/20" };
  }
  if (lower.includes("devops") || lower.includes("cloud") || lower.includes("docker") || lower.includes("infra")) {
    return { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/20" };
  }
  if (lower.includes("tool") || lower.includes("utility")) {
    return { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/20" };
  }
  if (lower.includes("database") || lower.includes("sql") || lower.includes("data")) {
    return { bg: "bg-rose-500/10", text: "text-rose-600 dark:text-rose-400", border: "border-rose-500/20" };
  }
  if (lower.includes("doc") || lower.includes("reference") || lower.includes("article")) {
    return { bg: "bg-teal-500/10", text: "text-teal-600 dark:text-teal-400", border: "border-teal-500/20" };
  }
  return { bg: "bg-primary/10", text: "text-primary", border: "border-primary/20" };
}

function parseJsonArray(input?: string | string[] | null): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  const [settingsTab, setSettingsTab] = useState<"ai" | "data" | "about">("ai");
  const [settingsKeyInput, setSettingsKeyInput] = useState(apiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyTestState, setApiKeyTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [apiKeyTestMessage, setApiKeyTestMessage] = useState("");

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

  // Theme state ('dark' | 'light' | 'system')
  const [theme, setTheme] = useState<"dark" | "light" | "system">(() => {
    return (localStorage.getItem("folio_theme") as "dark" | "light" | "system") || "dark";
  });

  useEffect(() => {
    localStorage.setItem("folio_theme", theme);
    const root = document.documentElement;
    if (theme === "system") {
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (systemDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    } else if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [theme]);

  // Active selection: null = All Bookmarks, 'recent' = Recent, or folderId
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [hideEmptyFolders, setHideEmptyFolders] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Category quick filter & Detail drawer states
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selectedBookmarkDetail, setSelectedBookmarkDetail] = useState<Bookmark | null>(null);
  const [showStatsWidget, setShowStatsWidget] = useState<boolean>(false);
  const [isDuplicateCleanerOpen, setIsDuplicateCleanerOpen] = useState<boolean>(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState<boolean>(false);
  const [paletteQuery, setPaletteQuery] = useState<string>("");

  // Global keyboard shortcut for Command Palette (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
    queryKey: ["folderTree", hideEmptyFolders],
    queryFn: async () =>
      getFolderTree({
        unwrapBookmarksBar: true,
        hideEmpty: hideEmptyFolders,
      }),
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

  // Extract all distinct categories and counts for horizontal filter bar and stats
  const categoryStats = (() => {
    const counts = new Map<string, number>();
    for (const b of bookmarks) {
      const cat = b.ai?.category || b.ai_category;
      if (cat && cat.trim() && cat !== "Uncategorized") {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  })();

  // Filter bookmarks by active categoryFilter if selected
  const displayBookmarks = categoryFilter
    ? bookmarks.filter((b) => {
        const cat = b.ai?.category || b.ai_category;
        return cat?.toLowerCase() === categoryFilter.toLowerCase();
      })
    : bookmarks;

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

  // Query duplicates for review and cleanup tool
  const { data: duplicateGroups = [], refetch: refetchDuplicates } = useQuery<DuplicateBookmarkGroup[]>({
    queryKey: ["duplicateGroups"],
    queryFn: async () => findDuplicateBookmarks(),
    enabled: dbReady && isDuplicateCleanerOpen,
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
    setApiKeyTestState("idle");
    toast.success("Settings saved", {
      description: trimmed
        ? "Gemini API key updated."
        : "Gemini API key removed.",
    });
    queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
  }

  // Test the API key by making a lightweight Gemini call
  async function handleTestApiKey() {
    const key = settingsKeyInput.trim();
    if (!key) {
      setApiKeyTestState("fail");
      setApiKeyTestMessage("Please enter an API key first.");
      return;
    }
    setApiKeyTestState("testing");
    setApiKeyTestMessage("");
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: key });
      const res = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: "Reply with exactly: OK",
        config: { maxOutputTokens: 5 },
      });
      const text = res.text?.trim() ?? "";
      if (text) {
        setApiKeyTestState("ok");
        setApiKeyTestMessage("API key is valid — Gemini responded successfully.");
      } else {
        setApiKeyTestState("fail");
        setApiKeyTestMessage("Received empty response. Key may be restricted.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setApiKeyTestState("fail");
      setApiKeyTestMessage(
        msg.includes("403") || msg.includes("API_KEY_INVALID")
          ? "Invalid API key. Please check and try again."
          : msg.includes("429")
          ? "Rate limited. Key is valid but quota is exhausted."
          : `Error: ${msg.slice(0, 120)}`
      );
    }
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

  // Handle exporting bookmarks back to browser-compatible Netscape HTML format
  async function handleExportBookmarks() {
    try {
      const htmlContent = await exportBookmarksToHtml();
      const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `folio-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      toast.success("Bookmarks exported successfully", {
        description: "Standard HTML file saved for browser import.",
      });
    } catch (err) {
      console.error("Export error:", err);
      toast.error("Failed to export bookmarks: " + String(err));
    }
  }

  // Handle deduplicating a cluster
  async function handleDeduplicateCluster(group: DuplicateBookmarkGroup, keepId: string) {
    try {
      const allIds = group.bookmarks.map((b) => b.id);
      await deduplicateGroup(keepId, allIds);
      toast.success("Duplicates resolved", {
        description: `Removed ${allIds.length - 1} duplicate records.`,
      });
      await refetchDuplicates();
      await queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
      await queryClient.invalidateQueries({ queryKey: ["bookmarkCount"] });
    } catch (err) {
      console.error("Deduplication failed:", err);
      toast.error("Failed to resolve duplicates: " + String(err));
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

      {/* Settings Dialog — tabbed, expanded */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="sm:max-w-lg p-0 overflow-hidden gap-0">
          {/* Dialog Header */}
          <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border/60">
            <div className="flex size-9 items-center justify-center rounded-xl bg-zinc-950 p-1.5 border border-border/60 shrink-0">
              <img src="/folio-logo.svg" alt="Folio" className="size-full rounded-md object-contain" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold leading-none">Folio Settings</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                Configure your app preferences and integrations
              </DialogDescription>
            </div>
          </div>

          {/* Tab Bar */}
          <div className="flex border-b border-border/60 px-6 bg-muted/20">
            {(["ai", "data", "about"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setSettingsTab(tab)}
                className={`px-3 py-2.5 text-xs font-medium capitalize border-b-2 transition-colors cursor-pointer -mb-px ${
                  settingsTab === tab
                    ? "border-primary text-primary font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab === "ai" ? "✦ AI" : tab === "data" ? "☰ Data" : "◎ About"}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="px-6 py-5 space-y-5 min-h-[260px]">

            {/* ── AI TAB ── */}
            {settingsTab === "ai" && (
              <form onSubmit={handleSaveSettings} className="space-y-5">
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="gemini-key" className="text-xs font-semibold text-foreground">
                        Google Gemini API Key
                      </label>
                      <button
                        type="button"
                        onClick={() => handleOpenBookmark("https://aistudio.google.com/app/apikey")}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline cursor-pointer"
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
                        onChange={(e) => {
                          setSettingsKeyInput(e.target.value);
                          setApiKeyTestState("idle");
                        }}
                        className="pr-9 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        title={showApiKey ? "Hide key" : "Show key"}
                      >
                        {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                      Used for AI summarization, categorization, and vector embeddings. Stored locally — never sent to any server other than Google's Gemini API.
                    </p>
                  </div>

                  {/* Test Key row */}
                  <div className="flex items-center gap-2.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTestApiKey}
                      disabled={apiKeyTestState === "testing" || !settingsKeyInput.trim()}
                      className="h-7 gap-1.5 text-xs cursor-pointer px-3 shrink-0"
                    >
                      {apiKeyTestState === "testing" ? (
                        <><Loader2 className="size-3 animate-spin" /> Testing...</>
                      ) : (
                        <><CheckCircle2 className="size-3" /> Test Key</>
                      )}
                    </Button>
                    {apiKeyTestState !== "idle" && apiKeyTestState !== "testing" && (
                      <span className={`text-[11px] flex items-center gap-1 leading-snug ${apiKeyTestState === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                        {apiKeyTestState === "ok"
                          ? <CheckCircle2 className="size-3 shrink-0" />
                          : <AlertCircle className="size-3 shrink-0" />}
                        {apiKeyTestMessage}
                      </span>
                    )}
                  </div>

                  {/* Models in use */}
                  <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2.5">
                    <p className="text-[11px] font-semibold text-foreground">Models in use</p>
                    {[
                      {
                        model: "gemini-3.8-flash",
                        role: "Classify & Summarize",
                        desc: "Categorizes bookmarks and writes page summaries",
                      },
                      {
                        model: "text-embedding-004",
                        role: "Vector Embeddings",
                        desc: "Powers semantic search — finds bookmarks by meaning",
                      },
                    ].map(({ model, role, desc }) => (
                      <div key={model} className="flex items-start gap-2.5">
                        <span className={`mt-1 size-1.5 rounded-full shrink-0 ${apiKey ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <code className="text-[11px] font-mono font-semibold text-foreground">{model}</code>
                            <span className="text-[10px] text-muted-foreground border border-border/60 rounded px-1.5 py-0.5 leading-none">{role}</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  {apiKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        localStorage.removeItem("gemini_api_key");
                        setApiKey("");
                        setSettingsKeyInput("");
                        setApiKeyTestState("idle");
                        toast.info("Gemini API Key removed.");
                        queryClient.invalidateQueries({ queryKey: ["bookmarks"] });
                      }}
                      className="text-xs text-destructive hover:text-destructive cursor-pointer"
                    >
                      Remove Key
                    </Button>
                  )}
                  <div className="flex gap-2 ml-auto">
                    <Button type="button" variant="outline" size="sm" onClick={() => setIsSettingsOpen(false)} className="text-xs cursor-pointer">
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" className="text-xs cursor-pointer">
                      Save
                    </Button>
                  </div>
                </div>
              </form>
            )}

            {/* ── DATA TAB ── */}
            {settingsTab === "data" && (
              <div className="space-y-4">
                {/* Import */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">Import Bookmarks</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Import a Netscape HTML bookmark file exported from Chrome, Firefox, Safari, or Edge.
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsSettingsOpen(false);
                        setTimeout(() => fileInputRef.current?.click(), 100);
                      }}
                      disabled={isImporting || !dbReady}
                      className="h-8 gap-2 text-xs cursor-pointer"
                    >
                      {isImporting ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                      {isImporting ? "Importing..." : "Import HTML File"}
                    </Button>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsSettingsOpen(false);
                        handleExportBookmarks();
                      }}
                      disabled={!dbReady || bookmarkCount === 0}
                      className="h-8 gap-2 text-xs cursor-pointer"
                    >
                      <Download className="size-3.5" />
                      Export HTML File
                    </Button>
                  </div>
                </div>

                <div className="border-t border-border/60" />

                {/* Library Health & Maintenance */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">Library Maintenance</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Scan for exact URL duplicates or matching page titles across folders to prune redundancy.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsSettingsOpen(false);
                      setIsDuplicateCleanerOpen(true);
                    }}
                    disabled={!dbReady || bookmarkCount === 0}
                    className="h-8 gap-2 text-xs cursor-pointer mt-1"
                  >
                    <ShieldCheck className="size-3.5 text-primary" />
                    Review & Clean Duplicates
                  </Button>
                </div>

                <div className="border-t border-border/60" />

                {/* Database stats */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">Local Database</p>
                  <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                    {[
                      { label: "Total bookmarks", value: bookmarkCount.toLocaleString() },
                      { label: "Pending AI indexing", value: unprocessedCount > 0 ? `${unprocessedCount} remaining` : "All indexed ✓" },
                      { label: "Storage engine", value: "SQLite (local)" },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono font-medium text-foreground">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-border/60" />

                {/* Danger zone */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-destructive">Danger Zone</p>
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[11px] font-medium text-foreground">Clear all data</p>
                      <p className="text-[11px] text-muted-foreground">Permanently deletes all bookmarks, folders, and AI data.</p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={async () => {
                        setIsSettingsOpen(false);
                        await new Promise((r) => setTimeout(r, 150));
                        handleClearDatabase();
                      }}
                      disabled={!dbReady}
                      className="text-xs cursor-pointer shrink-0"
                    >
                      <Trash2 className="size-3.5 mr-1.5" />
                      Clear All
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* ── ABOUT TAB ── */}
            {settingsTab === "about" && (
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-zinc-950 p-2.5 border border-border/60 shrink-0">
                    <img src="/folio-logo.svg" alt="Folio" className="size-full rounded-lg object-contain" />
                  </div>
                  <div>
                    <p className="text-base font-bold">Folio</p>
                    <p className="text-xs text-muted-foreground">Version 0.1.0</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Intelligent local bookmark library</p>
                  </div>
                </div>

                <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
                  {[
                    { label: "Framework", value: "Tauri v2 + React 19" },
                    { label: "Database", value: "SQLite via Drizzle ORM" },
                    { label: "AI Provider", value: "Google Gemini" },
                    { label: "Search", value: "FTS5 + Vector embeddings" },
                    { label: "Font", value: "Geist Variable" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-mono font-medium text-foreground">{value}</span>
                    </div>
                  ))}
                </div>

                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Folio is a privacy-first, fully offline desktop bookmark manager. All data stays on your device. AI processing is done client-side using your own Gemini API key.
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Duplicate Cleaner Dialog Modal */}
      <Dialog open={isDuplicateCleanerOpen} onOpenChange={setIsDuplicateCleanerOpen}>
        <DialogContent className="sm:max-w-xl p-0 overflow-hidden gap-0 max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border/60 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <ShieldCheck className="size-4" />
              </div>
              <div>
                <DialogTitle className="text-sm font-semibold leading-none">
                  Duplicate & Redundancy Cleaner
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                  Resolve duplicate URLs and identical page titles across folders
                </DialogDescription>
              </div>
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              {duplicateGroups.length} {duplicateGroups.length === 1 ? "group" : "groups"} found
            </span>
          </div>

          <ScrollArea className="flex-1 p-6">
            {duplicateGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="size-12 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center mb-3">
                  <CheckCircle2 className="size-6" />
                </div>
                <h4 className="text-sm font-semibold text-foreground">Library is fully optimized!</h4>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  No duplicate URLs or matching content titles were detected across your library.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {duplicateGroups.map((group, idx) => (
                  <div
                    key={group.key || idx}
                    className="rounded-xl border border-border/60 bg-muted/20 p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium leading-none mb-1">
                          {group.reason === "normalized_url" ? "Identical URL" : "Identical Title & Domain"}
                        </span>
                        <p className="text-xs font-mono text-muted-foreground truncate">
                          {group.normalizedUrl || group.key}
                        </p>
                      </div>

                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-xs h-7 shrink-0 cursor-pointer"
                        onClick={() => handleDeduplicateCluster(group, group.bookmarks[0].id)}
                      >
                        Keep 1st & Prune Rest
                      </Button>
                    </div>

                    {/* Duplicate bookmark rows */}
                    <div className="space-y-1.5 pt-1">
                      {group.bookmarks.map((bm, bIdx) => (
                        <div
                          key={bm.id}
                          className="flex items-center justify-between gap-3 text-xs p-2 rounded-lg bg-background/60 border border-border/40"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-foreground truncate">{bm.title || bm.url}</p>
                            <p className="text-[10px] text-muted-foreground font-mono truncate">{bm.url}</p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {bIdx === 0 && (
                              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium px-1.5 py-0.5 rounded bg-emerald-500/10">
                                Primary
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeduplicateCluster(group, bm.id)}
                              className="text-[11px] text-primary hover:underline cursor-pointer"
                            >
                              Keep this
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Global Command Palette (Cmd+K / Ctrl+K) */}
      <Dialog open={isPaletteOpen} onOpenChange={setIsPaletteOpen}>
        <DialogContent className="sm:max-w-xl p-0 overflow-hidden gap-0 shadow-2xl border-border/80">
          <div className="flex items-center px-4 py-3 border-b border-border/60 bg-muted/20">
            <Search className="size-4 text-muted-foreground mr-3 shrink-0" />
            <input
              type="text"
              autoFocus
              placeholder="Type a command or search library (e.g. React, Theme, Index, Export)..."
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              className="w-full bg-transparent border-0 p-0 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden"
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 rounded bg-muted/80 border border-border/60 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              ESC
            </kbd>
          </div>

          <ScrollArea className="max-h-[380px] p-2">
            <div className="space-y-3">
              {/* Actions Group */}
              <div className="space-y-1">
                <span className="px-3 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
                  Quick Actions
                </span>

                {[
                  {
                    label: "Toggle Theme (Dark / Light / System)",
                    icon: Moon,
                    shortcut: "T",
                    action: () => {
                      setTheme((prev) => (prev === "dark" ? "light" : prev === "light" ? "system" : "dark"));
                      setIsPaletteOpen(false);
                    },
                  },
                  {
                    label: "Scan & Clean Duplicates",
                    icon: ShieldCheck,
                    shortcut: "D",
                    action: () => {
                      setIsPaletteOpen(false);
                      setIsDuplicateCleanerOpen(true);
                    },
                  },
                  {
                    label: "Export Bookmarks to HTML",
                    icon: Download,
                    shortcut: "E",
                    action: () => {
                      setIsPaletteOpen(false);
                      handleExportBookmarks();
                    },
                  },
                  {
                    label: isIndexing ? "Pause AI Indexing" : "Run AI Indexing Queue",
                    icon: Sparkles,
                    shortcut: "I",
                    action: () => {
                      setIsPaletteOpen(false);
                      handleToggleIndexing();
                    },
                  },
                  {
                    label: "Switch to Card Grid View",
                    icon: LayoutGrid,
                    shortcut: "V",
                    action: () => {
                      setViewMode("cards");
                      setIsPaletteOpen(false);
                    },
                  },
                  {
                    label: "Switch to Context List View",
                    icon: List,
                    shortcut: "L",
                    action: () => {
                      setViewMode("list");
                      setIsPaletteOpen(false);
                    },
                  },
                  {
                    label: "Open App Settings",
                    icon: Settings,
                    shortcut: "S",
                    action: () => {
                      setIsPaletteOpen(false);
                      setIsSettingsOpen(true);
                    },
                  },
                ]
                  .filter((cmd) => cmd.label.toLowerCase().includes(paletteQuery.toLowerCase()))
                  .map((cmd) => {
                    const Icon = cmd.icon;
                    return (
                      <button
                        key={cmd.label}
                        type="button"
                        onClick={cmd.action}
                        className="flex w-full items-center justify-between px-3 py-2 rounded-lg text-xs hover:bg-accent/60 transition-colors text-left cursor-pointer group"
                      >
                        <div className="flex items-center gap-2.5">
                          <Icon className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
                          <span className="font-medium text-foreground">{cmd.label}</span>
                        </div>
                        <CornerDownLeft className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    );
                  })}
              </div>

              {/* Matching Bookmarks Group */}
              {paletteQuery.trim() && (
                <div className="space-y-1 pt-2 border-t border-border/40">
                  <span className="px-3 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground">
                    Matching Bookmarks
                  </span>
                  {bookmarks
                    .filter(
                      (b) =>
                        (b.title || "").toLowerCase().includes(paletteQuery.toLowerCase()) ||
                        b.url.toLowerCase().includes(paletteQuery.toLowerCase())
                    )
                    .slice(0, 5)
                    .map((bm) => (
                      <button
                        key={bm.id}
                        type="button"
                        onClick={() => {
                          setIsPaletteOpen(false);
                          handleOpenBookmark(bm.url);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 rounded-lg text-xs hover:bg-accent/60 transition-colors text-left cursor-pointer group"
                      >
                        <div className="min-w-0 flex-1 pr-3">
                          <p className="font-medium text-foreground truncate">{bm.title || bm.url}</p>
                          <p className="text-[10px] font-mono text-muted-foreground truncate">{bm.url}</p>
                        </div>
                        <ArrowUpRight className="size-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                      </button>
                    ))}
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 1. Top Search Bar & Actions */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border/80 bg-background/95 px-5 backdrop-blur-md gap-6">
        {/* Brand / Logo */}
        <div className="flex items-center gap-3 shrink-0 select-none">
          <div className="flex size-9 items-center justify-center rounded-xl bg-zinc-950 p-1.5 shadow-xs border border-border/60">
            <img src="/folio-logo.svg" alt="Folio logo" className="size-full rounded-md object-contain" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <h1 className="text-base font-semibold tracking-tight leading-none text-foreground">
                Folio
              </h1>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 leading-none">
                AI
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground font-medium mt-0.5">
              Intelligent Bookmarks
            </span>
          </div>
        </div>

        {/* Fluent Search Box with Embedded Semantic Toggle */}
        <div className="flex items-center flex-1 max-w-2xl mx-auto">
          <div className="relative flex items-center w-full h-10 rounded-full border border-border/80 bg-muted/40 hover:bg-muted/60 focus-within:bg-background focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 transition-all shadow-xs px-3.5">
            <Search className="size-4 text-muted-foreground shrink-0 pointer-events-none mr-2.5" />
            <input
              type="text"
              placeholder={
                searchMode === "semantic"
                  ? "Describe what you're looking for (e.g. machine learning pipelines, rust tauri tutorials)..."
                  : "Search bookmarks by title, link, or keywords..."
              }
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              disabled={!dbReady}
              className="w-full bg-transparent border-0 p-0 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden disabled:opacity-50"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="p-1 text-muted-foreground hover:text-foreground cursor-pointer rounded-full transition-colors mr-1"
                title="Clear query"
              >
                <X className="size-3.5" />
              </button>
            )}

            {/* In-bar Semantic AI Mode Pill */}
            <button
              type="button"
              onClick={() => {
                const nextMode = searchMode === "semantic" ? "fts" : "semantic";
                setSearchMode(nextMode);
                if (nextMode === "semantic" && !apiKey.trim()) {
                  toast.info("Gemini API key is required for Semantic Search", {
                    action: {
                      label: "Configure",
                      onClick: () => {
                        setSettingsKeyInput(apiKey);
                        setIsSettingsOpen(true);
                      },
                    },
                  });
                }
              }}
              title={
                searchMode === "semantic"
                  ? "Semantic AI search active (Click to switch to Keyword search)"
                  : "Click to activate Semantic AI search"
              }
              className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-medium transition-all shrink-0 cursor-pointer ${
                searchMode === "semantic"
                  ? "bg-primary text-primary-foreground shadow-xs font-semibold"
                  : "bg-background text-muted-foreground hover:text-foreground border border-border/70 hover:border-border"
              }`}
            >
              <Sparkles className={`size-3.5 ${searchMode === "semantic" ? "text-cyan-300 animate-pulse" : "text-muted-foreground"}`} />
              <span>Semantic</span>
            </button>
          </div>
        </div>

        {/* Clean Header Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {isBookmarksFetching && (
            <Loader2 className="size-4 animate-spin text-muted-foreground mr-1" />
          )}

          {/* AI Queue Control (Pill status / trigger) */}
          <button
            type="button"
            onClick={handleToggleIndexing}
            disabled={!dbReady || isImporting}
            title={
              isIndexing
                ? queueStats.status === "backing_off"
                  ? `Rate limited: retrying in ${queueStats.backoffSecondsRemaining ?? 10}s. Click to pause.`
                  : "Pause AI indexing queue"
                : unprocessedCount > 0
                ? `Run AI indexing on ${unprocessedCount} unindexed bookmarks`
                : "All bookmarks processed"
            }
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium transition-all cursor-pointer border ${
              isIndexing
                ? queueStats.status === "backing_off"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "border-primary/20 bg-primary/10 text-primary"
                : unprocessedCount > 0
                ? "border-primary/20 bg-primary/5 text-foreground hover:bg-primary/10"
                : "border-transparent text-muted-foreground hover:bg-muted/60"
            }`}
          >
            {isIndexing ? (
              queueStats.status === "backing_off" ? (
                <>
                  <Clock className="size-3 animate-pulse text-amber-500" />
                  <span className="hidden md:inline font-mono text-[11px]">{queueStats.backoffSecondsRemaining ?? 10}s</span>
                </>
              ) : (
                <>
                  <Loader2 className="size-3 animate-spin text-primary" />
                  <span className="hidden md:inline">Indexing</span>
                </>
              )
            ) : (
              <>
                <Sparkles className="size-3 text-muted-foreground" />
                <span className="hidden md:inline">Index AI</span>
                {unprocessedCount > 0 && (
                  <span className="rounded-full bg-primary/15 text-primary px-1.5 py-0.2 text-[10px] font-mono font-semibold">
                    {unprocessedCount}
                  </span>
                )}
              </>
            )}
          </button>

          {/* Theme Switcher Button */}
          <button
            type="button"
            onClick={() => {
              setTheme((prev) => (prev === "dark" ? "light" : prev === "light" ? "system" : "dark"));
            }}
            className="flex size-8 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
            title={`Current theme: ${theme} (Click to toggle)`}
          >
            {theme === "dark" ? (
              <Moon className="size-3.5 text-indigo-400" />
            ) : theme === "light" ? (
              <Sun className="size-3.5 text-amber-500" />
            ) : (
              <Monitor className="size-3.5" />
            )}
          </button>

          {/* Stats Bar Toggle Button */}
          <button
            type="button"
            onClick={() => setShowStatsWidget((prev) => !prev)}
            className={`flex size-8 items-center justify-center rounded-md border transition-colors cursor-pointer ${
              showStatsWidget
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
            title={showStatsWidget ? "Hide library insights" : "Show library insights"}
          >
            <BarChart3 className="size-3.5" />
          </button>

          {/* Quick Duplicate Cleaner Trigger Button */}
          <button
            type="button"
            onClick={() => setIsDuplicateCleanerOpen(true)}
            className="flex size-8 items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
            title="Scan & Clean Duplicate Bookmarks"
          >
            <ShieldCheck className="size-3.5" />
          </button>

          {/* Command Palette Trigger Button */}
          <button
            type="button"
            onClick={() => setIsPaletteOpen(true)}
            className="hidden sm:flex items-center gap-1.5 h-8 px-2 rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer text-xs"
            title="Open Command Palette (Cmd+K)"
          >
            <Command className="size-3.5" />
            <kbd className="text-[10px] font-mono opacity-70">⌘K</kbd>
          </button>

          {/* Import Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!dbReady || isImporting}
            className="h-8 gap-1.5 text-xs font-medium cursor-pointer px-2.5"
            title="Import HTML bookmarks"
          >
            {isImporting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            <span className="hidden lg:inline">Import</span>
          </Button>
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
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setHideEmptyFolders((prev) => !prev)}
                      className={`inline-flex items-center gap-1 text-[10px] lowercase tracking-normal px-1.5 py-0.5 rounded transition-colors cursor-pointer border ${
                        hideEmptyFolders
                          ? "border-primary/20 bg-primary/10 text-primary font-medium"
                          : "border-border/60 text-muted-foreground hover:text-foreground"
                      }`}
                      title={
                        hideEmptyFolders
                          ? "Hiding empty folders (Click to show all)"
                          : "Showing all folders (Click to hide empty)"
                      }
                    >
                      <Filter className="size-2.5" />
                      <span>{hideEmptyFolders ? "active only" : "all"}</span>
                    </button>
                    <span className="text-[10px] font-mono">{folders.length}</span>
                  </div>
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

          {/* Sidebar Footer */}
          <div className="border-t border-border/60 shrink-0 bg-muted/5">
            {/* DB & AI status row */}
            <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground border-b border-border/40">
              <span
                className="flex items-center gap-1.5 cursor-default"
                title={dbError ? `Database error: ${dbError}` : "SQLite connected"}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    dbReady
                      ? "bg-emerald-500 ring-2 ring-emerald-500/20"
                      : dbError
                      ? "bg-destructive ring-2 ring-destructive/20"
                      : "bg-amber-500 animate-pulse"
                  }`}
                />
                <Database className="size-3" />
                <span>{bookmarkCount.toLocaleString()} bookmarks</span>
              </span>
              {unprocessedCount > 0 && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <Sparkles className="size-2.5" />
                  <span className="font-mono">{unprocessedCount} pending</span>
                </span>
              )}
            </div>

            {/* Settings Button */}
            <button
              type="button"
              onClick={() => {
                setSettingsTab("ai");
                setSettingsKeyInput(apiKey);
                setIsSettingsOpen(true);
              }}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors cursor-pointer group"
            >
              <div className="flex size-6 items-center justify-center rounded-md bg-muted/60 group-hover:bg-muted transition-colors">
                <Settings className="size-3.5" />
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium text-xs leading-none">Settings</p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">AI keys, data & about</p>
              </div>
              <span className={`size-1.5 rounded-full ${apiKey ? "bg-emerald-500" : "bg-amber-500"}`} title={apiKey ? "API key configured" : "No API key set"} />
            </button>
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
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-muted-foreground font-mono">
                {bookmarks.length} {bookmarks.length === 1 ? "item" : "items"}
              </span>

              {/* View Switcher: Rich Cards vs Compact Context List */}
              <div className="flex items-center rounded-lg border border-border/60 bg-muted/30 p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("cards")}
                  className={`flex size-7 items-center justify-center rounded-md transition-colors cursor-pointer ${
                    viewMode === "cards"
                      ? "bg-background text-foreground shadow-xs font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Card view (Grid of rich bookmark cards)"
                >
                  <LayoutGrid className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  className={`flex size-7 items-center justify-center rounded-md transition-colors cursor-pointer ${
                    viewMode === "list"
                      ? "bg-background text-foreground shadow-xs font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="List view (Structured full-context rows)"
                >
                  <List className="size-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Collapsible Stats & Insights Widget */}
          {showStatsWidget && (
            <div className="border-b border-border/60 bg-muted/20 px-6 py-3 transition-all animate-in fade-in duration-200">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="rounded-lg border border-border/50 bg-background/60 p-2.5">
                  <span className="text-[11px] text-muted-foreground font-medium">Total Bookmarks</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{bookmarkCount.toLocaleString()}</p>
                </div>
                <div className="rounded-lg border border-border/50 bg-background/60 p-2.5">
                  <span className="text-[11px] text-muted-foreground font-medium">AI Indexed</span>
                  <p className="text-base font-bold text-primary mt-0.5">
                    {bookmarkCount > 0
                      ? `${Math.round(((bookmarkCount - unprocessedCount) / bookmarkCount) * 100)}%`
                      : "0%"}
                  </p>
                </div>
                <div className="rounded-lg border border-border/50 bg-background/60 p-2.5">
                  <span className="text-[11px] text-muted-foreground font-medium">Categories</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{categoryStats.length}</p>
                </div>
                <div className="rounded-lg border border-border/50 bg-background/60 p-2.5">
                  <span className="text-[11px] text-muted-foreground font-medium">Folders</span>
                  <p className="text-base font-bold text-foreground mt-0.5">{folders.length}</p>
                </div>
              </div>
            </div>
          )}

          {/* Horizontal Category Quick-Filter Strip */}
          {categoryStats.length > 0 && (
            <div className="flex items-center gap-1.5 px-6 py-2 border-b border-border/40 bg-card/10 overflow-x-auto no-scrollbar shrink-0">
              <button
                type="button"
                onClick={() => setCategoryFilter(null)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                  categoryFilter === null
                    ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                    : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/70"
                }`}
              >
                <span>All Categories</span>
                <span className="text-[10px] opacity-75 font-mono">({bookmarks.length})</span>
              </button>

              {categoryStats.map(({ name, count }) => {
                const isSelected = categoryFilter?.toLowerCase() === name.toLowerCase();
                const style = getCategoryBadgeStyle(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setCategoryFilter(isSelected ? null : name)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all cursor-pointer border ${
                      isSelected
                        ? `${style.bg} ${style.text} border-primary font-semibold ring-1 ring-primary/30`
                        : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span>{name}</span>
                    <span className="text-[10px] font-mono opacity-70">({count})</span>
                  </button>
                );
              })}
            </div>
          )}

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
                <div className="flex flex-col items-center justify-center py-24 text-center max-w-sm mx-auto">
                  {debouncedSearchQuery.trim() ? (
                    <>
                      <div className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground mb-3">
                        <Search className="size-5" />
                      </div>
                      <h3 className="text-sm font-semibold">No bookmarks found</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {searchMode === "semantic"
                          ? `No matching bookmarks found for "${debouncedSearchQuery}". Try adjusting your query or indexing more bookmarks.`
                          : `No bookmarks match "${debouncedSearchQuery}". Try another keyword or check for spelling.`}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex size-16 items-center justify-center rounded-2xl bg-zinc-950 p-2.5 shadow-md border border-border/60 mb-4">
                        <img src="/folio-logo.svg" alt="Folio logo" className="size-full rounded-lg object-contain" />
                      </div>
                      <h3 className="text-base font-semibold">Welcome to Folio</h3>
                      <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                        Your intelligent local bookmark library with semantic search and AI summarization. Import your browser bookmarks to get started.
                      </p>
                      <Button
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-4 gap-1.5 text-xs cursor-pointer shadow-xs"
                        size="sm"
                      >
                        <Upload className="size-3.5" />
                        Import HTML Bookmarks
                      </Button>
                    </>
                  )}
                </div>
              ) : displayBookmarks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center max-w-sm mx-auto">
                  <div className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground mb-3">
                    <Filter className="size-5" />
                  </div>
                  <h3 className="text-sm font-semibold">No bookmarks in "{categoryFilter}"</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try choosing another category or clearing the filter.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCategoryFilter(null)}
                    className="mt-3 text-xs"
                  >
                    Clear Filter
                  </Button>
                </div>
              ) : (
                <div
                  className={
                    viewMode === "cards"
                      ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5"
                      : "space-y-2.5"
                  }
                >
                  {displayBookmarks.map((bookmark) => {
                    const category = bookmark.ai?.category || bookmark.ai_category;
                    const displaySummary = bookmark.ai?.summary || bookmark.ai_summary;
                    const similarityScore = bookmark.similarityScore;
                    const tags = parseJsonArray(bookmark.ai?.tags || bookmark.ai_tags);
                    const technologies = parseJsonArray(
                      bookmark.ai?.technologies || bookmark.ai_technologies
                    );
                    const catStyle = getCategoryBadgeStyle(category);

                    const faviconUrl = bookmark.domain
                      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
                          bookmark.domain
                        )}&sz=64`
                      : null;

                    const handleCopyUrl = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(bookmark.url);
                      setCopiedId(bookmark.id);
                      toast.success("URL copied to clipboard", { duration: 2000 });
                      setTimeout(() => setCopiedId(null), 1800);
                    };

                    if (viewMode === "cards") {
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
                          className="group relative flex flex-col justify-between rounded-xl border border-border/50 bg-card/50 p-4 hover:bg-card/90 hover:border-primary/40 hover:shadow-md transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-xs"
                        >
                          <div className="space-y-3">
                            {/* Card Header: Favicon + Domain + Similarity / Actions */}
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                {faviconUrl ? (
                                  <div className="size-6 rounded-md bg-muted/60 p-0.5 shrink-0 border border-border/40 overflow-hidden flex items-center justify-center">
                                    <img
                                      src={faviconUrl}
                                      alt=""
                                      onError={(e) => {
                                        (e.target as HTMLElement).style.display = "none";
                                      }}
                                      className="size-full object-contain rounded-xs"
                                    />
                                  </div>
                                ) : (
                                  <div className="size-6 rounded-md bg-muted/60 flex items-center justify-center shrink-0 text-muted-foreground">
                                    <FileText className="size-3.5" />
                                  </div>
                                )}
                                <span className="text-[11px] font-mono text-muted-foreground truncate font-medium">
                                  {bookmark.domain || "link"}
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                {typeof similarityScore === "number" && (
                                  <span className="inline-flex items-center rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                                    {Math.max(0, Math.round(similarityScore * 100))}%
                                  </span>
                                )}

                                {/* Quick action buttons */}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedBookmarkDetail(bookmark);
                                  }}
                                  className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                                  title="View Details & Full Summary"
                                >
                                  <Info className="size-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCopyUrl}
                                  className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                                  title="Copy URL"
                                >
                                  {copiedId === bookmark.id ? (
                                    <Check className="size-3 text-emerald-500" />
                                  ) : (
                                    <Copy className="size-3" />
                                  )}
                                </button>
                                <ExternalLink className="size-3 text-muted-foreground/60 group-hover:text-primary transition-colors shrink-0" />
                              </div>
                            </div>

                            {/* Title */}
                            <h4 className="text-sm font-semibold leading-snug text-foreground group-hover:text-primary transition-colors line-clamp-2">
                              {bookmark.title || bookmark.url}
                            </h4>

                            {/* Summary / Description */}
                            {displaySummary ? (
                              <div className="rounded-lg bg-muted/30 border border-border/40 p-2.5">
                                <p className="text-xs text-foreground/90 line-clamp-3 leading-relaxed flex items-start gap-1.5">
                                  <Sparkles className="size-3 text-amber-500 shrink-0 mt-0.5" />
                                  <span>{displaySummary}</span>
                                </p>
                              </div>
                            ) : bookmark.description ? (
                              <p className="text-xs text-muted-foreground/80 line-clamp-2 leading-relaxed">
                                {bookmark.description}
                              </p>
                            ) : null}
                          </div>

                          {/* Card Footer: Badges & Tags */}
                          <div className="pt-3 mt-2 border-t border-border/40 flex flex-wrap items-center gap-1.5">
                            {category && (
                              <span
                                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium leading-none ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}
                              >
                                <Sparkles className="size-2.5" />
                                {category}
                              </span>
                            )}

                            {technologies.slice(0, 2).map((tech) => (
                              <span
                                key={tech}
                                className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground leading-none"
                              >
                                <Cpu className="size-2.5 opacity-60" />
                                {tech}
                              </span>
                            ))}

                            {tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-0.5 rounded-md border border-border/40 bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground/80 leading-none"
                              >
                                <Tag className="size-2.5 opacity-50" />
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    // ViewMode: "list" (Structured Full-Context Row)
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
                        className="group flex items-start gap-3.5 rounded-xl border border-border/40 bg-card/40 p-3.5 hover:bg-card/90 hover:border-border transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-xs"
                      >
                        {/* Favicon or fallback icon */}
                        {faviconUrl ? (
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 p-1 border border-border/50 group-hover:border-primary/30 transition-colors mt-0.5 overflow-hidden">
                            <img
                              src={faviconUrl}
                              alt=""
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = "none";
                              }}
                              className="size-full object-contain rounded-xs"
                            />
                          </div>
                        ) : (
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors mt-0.5">
                            <FileText className="size-4" />
                          </div>
                        )}

                        {/* Bookmark Content */}
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <h4 className="text-sm font-semibold leading-snug text-foreground group-hover:text-primary transition-colors truncate">
                              {bookmark.title || bookmark.url}
                            </h4>

                            {/* Badges container */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              {/* Category Badge with Color Tagging */}
                              {category && (
                                <span
                                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium leading-none ${catStyle.bg} ${catStyle.text} ${catStyle.border}`}
                                >
                                  <Sparkles className="size-2.5" />
                                  {category}
                                </span>
                              )}

                              {/* Semantic match percentage */}
                              {typeof similarityScore === "number" && (
                                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                                  {Math.max(0, Math.round(similarityScore * 100))}% match
                                </span>
                              )}

                              {/* Domain Badge */}
                              {bookmark.domain && (
                                <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-mono text-muted-foreground border border-border/40">
                                  <Globe className="size-2.5 opacity-60" />
                                  {bookmark.domain}
                                </span>
                              )}

                              {/* Quick action buttons */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedBookmarkDetail(bookmark);
                                }}
                                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                                title="View Details & Full Summary"
                              >
                                <Info className="size-3" />
                              </button>
                              <button
                                type="button"
                                onClick={handleCopyUrl}
                                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors opacity-0 group-hover:opacity-100"
                                title="Copy URL"
                              >
                                {copiedId === bookmark.id ? (
                                  <Check className="size-3 text-emerald-500" />
                                ) : (
                                  <Copy className="size-3" />
                                )}
                              </button>
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

                          {/* Technologies and Tags pills */}
                          {(technologies.length > 0 || tags.length > 0) && (
                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              {technologies.slice(0, 3).map((tech) => (
                                <span
                                  key={tech}
                                  className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.2 text-[10px] font-mono text-muted-foreground"
                                >
                                  <Cpu className="size-2.5 opacity-60" />
                                  {tech}
                                </span>
                              ))}
                              {tags.slice(0, 3).map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-flex items-center gap-0.5 rounded border border-border/30 bg-muted/20 px-1.5 py-0.2 text-[10px] text-muted-foreground/80"
                                >
                                  <Tag className="size-2.5 opacity-50" />
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}

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

        {/* 5. Slide-Out Bookmark Detail Drawer */}
        {selectedBookmarkDetail && (
          <aside className="w-80 sm:w-96 shrink-0 border-l border-border bg-card/60 backdrop-blur-md flex flex-col justify-between h-full z-20 animate-in slide-in-from-right duration-200">
            <div className="flex flex-col h-full min-h-0">
              {/* Drawer Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
                <div className="flex items-center gap-2">
                  <div className="size-6 rounded-md bg-muted/60 flex items-center justify-center text-primary">
                    <Info className="size-3.5" />
                  </div>
                  <span className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">
                    Bookmark Inspector
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedBookmarkDetail(null)}
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                  title="Close Inspector"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* Drawer Content */}
              <ScrollArea className="flex-1 p-5">
                <div className="space-y-5">
                  {/* Title & Domain */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      {selectedBookmarkDetail.domain && (
                        <div className="size-5 rounded bg-muted/50 p-0.5 shrink-0 overflow-hidden flex items-center justify-center border border-border/40">
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(
                              selectedBookmarkDetail.domain
                            )}&sz=64`}
                            alt=""
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = "none";
                            }}
                            className="size-full object-contain"
                          />
                        </div>
                      )}
                      <span className="text-xs font-mono text-muted-foreground">
                        {selectedBookmarkDetail.domain || "Web Link"}
                      </span>
                    </div>

                    <h3 className="text-sm font-semibold text-foreground leading-snug">
                      {selectedBookmarkDetail.title || selectedBookmarkDetail.url}
                    </h3>
                  </div>

                  {/* Category & Similarity badge */}
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const cat = selectedBookmarkDetail.ai?.category || selectedBookmarkDetail.ai_category;
                      if (!cat) return null;
                      const style = getCategoryBadgeStyle(cat);
                      return (
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text} ${style.border}`}
                        >
                          <Sparkles className="size-3" />
                          {cat}
                        </span>
                      );
                    })()}

                    {typeof selectedBookmarkDetail.similarityScore === "number" && (
                      <span className="inline-flex items-center rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-1 text-xs font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                        {Math.max(0, Math.round(selectedBookmarkDetail.similarityScore * 100))}% semantic match
                      </span>
                    )}
                  </div>

                  {/* AI Summary Card */}
                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      AI Summary
                    </span>
                    <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 space-y-2">
                      {selectedBookmarkDetail.ai?.summary || selectedBookmarkDetail.ai_summary ? (
                        <p className="text-xs text-foreground/90 leading-relaxed">
                          {selectedBookmarkDetail.ai?.summary || selectedBookmarkDetail.ai_summary}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">
                          No AI summary generated yet. Click "Index AI" in the header to synthesize metadata for this bookmark.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Technologies */}
                  {(() => {
                    const techs = parseJsonArray(
                      selectedBookmarkDetail.ai?.technologies || selectedBookmarkDetail.ai_technologies
                    );
                    if (techs.length === 0) return null;
                    return (
                      <div className="space-y-2">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Technologies
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {techs.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs font-mono text-foreground"
                            >
                              <Cpu className="size-3 text-muted-foreground" />
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Tags */}
                  {(() => {
                    const tags = parseJsonArray(
                      selectedBookmarkDetail.ai?.tags || selectedBookmarkDetail.ai_tags
                    );
                    if (tags.length === 0) return null;
                    return (
                      <div className="space-y-2">
                        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Tags
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          {tags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-muted/20 px-2 py-1 text-xs text-muted-foreground"
                            >
                              <Tag className="size-3 opacity-60" />
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* URL Section */}
                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                      Canonical URL
                    </span>
                    <div className="rounded-lg border border-border/40 bg-muted/20 p-2.5 break-all text-xs font-mono text-muted-foreground select-all">
                      {selectedBookmarkDetail.url}
                    </div>
                  </div>

                  {/* Added Date */}
                  {selectedBookmarkDetail.created_at && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t border-border/40">
                      <span>Date Added</span>
                      <span>
                        {new Date(selectedBookmarkDetail.created_at).toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  )}
                </div>
              </ScrollArea>

              {/* Drawer Footer Actions */}
              <div className="p-4 border-t border-border/60 bg-muted/20 flex items-center gap-2">
                <Button
                  size="sm"
                  className="flex-1 text-xs gap-1.5 cursor-pointer"
                  onClick={() => handleOpenBookmark(selectedBookmarkDetail.url)}
                >
                  <ArrowUpRight className="size-3.5" />
                  Open in Browser
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5 cursor-pointer"
                  onClick={() => {
                    navigator.clipboard.writeText(selectedBookmarkDetail.url);
                    toast.success("URL copied to clipboard");
                  }}
                >
                  <Copy className="size-3.5" />
                  Copy
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
