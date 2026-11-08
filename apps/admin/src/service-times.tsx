import "@community-hub/ui/rich-text-editor.css";

import { terminology } from "@community-hub/faith-church";
import { Alert, Button, Panel } from "@community-hub/ui";
import { type RichTextEditorHandle, RichTextEditor } from "@community-hub/ui/rich-text-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";

import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { usePeopleAccess } from "./people-access";
import { ScreenTitle } from "./screen-title";
import { getServiceTimes, saveServiceTimes, SERVICE_TIMES_HTML_MAX } from "./service-times-api";

export function ServiceTimesPage() {
  const term = terminology("engagement.service_times");
  const { access } = usePeopleAccess();
  const hasAccess =
    access.entitlements["module.engagement"] && access.permissions["service_times.manage"];

  const { slug, version: communityVersion, setSlug } = useCommunity();
  const { refresh: refreshBilling } = useBillingStatus();

  const editorRef = useRef<RichTextEditorHandle>(null);
  const baselineRef = useRef<string>("");
  const versionRef = useRef<number>(0);
  const loadGeneration = useRef<number>(0);
  const saveGeneration = useRef<number>(0);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const loadedSlugRef = useRef<string | null>(null);
  const pendingRevertSlugRef = useRef<string | null>(null);
  const cancellingSwitchRef = useRef<boolean>(false);
  const savingRef = useRef<boolean>(false);
  const blockerAlertRef = useRef<HTMLDivElement>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [dirty, setDirty] = useState<boolean>(false);
  const [loadedCommunitySlug, setLoadedCommunitySlug] = useState<string | null>(null);
  const [pendingCommunitySlug, setPendingCommunitySlug] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showReload, setShowReload] = useState<boolean>(false);

  const isReady =
    pendingCommunitySlug === null && loadedCommunitySlug !== null && loadedCommunitySlug === slug;

  // In-app navigation blocker
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (blocker.state === "blocked" || pendingCommunitySlug !== null) {
      blockerAlertRef.current?.focus();
    }
  }, [blocker.state, pendingCommunitySlug]);

  // Window beforeunload blocker
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [dirty]);

  const loadData = useCallback(async (communitySlug: string) => {
    saveGeneration.current++;
    const mine = ++loadGeneration.current;

    if (communitySlug !== loadedSlugRef.current) {
      editorRef.current?.setContent("");
      baselineRef.current = "";
      versionRef.current = 0;
      loadedSlugRef.current = null;
      setLoadedCommunitySlug(null);
      setDirty(false);
    }

    setIsLoading(true);
    setErrorMessage(null);
    setShowReload(false);

    try {
      const outcome = await getServiceTimes(communitySlug);
      if (loadGeneration.current !== mine) {
        return;
      }

      if (outcome.kind === "ok") {
        versionRef.current = outcome.data.version;
        editorRef.current?.setContent(outcome.data.html);
        // Capture baseline right after setContent (Pin 25)
        const newBaseline = editorRef.current?.getHTML() ?? "";
        baselineRef.current = newBaseline;
        loadedSlugRef.current = communitySlug;
        setLoadedCommunitySlug(communitySlug);
        setDirty(false);
        setSavedMessage(null);
        setShowReload(false);
      } else if (outcome.kind === "forbidden") {
        setErrorMessage("You do not have permission to view this.");
        setShowReload(false);
      } else {
        setErrorMessage("Could not load. Try again.");
        setShowReload(true);
      }
    } catch {
      if (loadGeneration.current === mine) {
        setErrorMessage("Could not load. Try again.");
        setShowReload(true);
      }
    } finally {
      if (loadGeneration.current === mine) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!slug || !hasAccess || pendingCommunitySlug !== null) {
      if (!slug || !hasAccess) {
        setIsLoading(false);
      }
      return;
    }
    if (cancellingSwitchRef.current) {
      cancellingSwitchRef.current = false;
      lastLoadedKeyRef.current = `${slug}|${communityVersion}`;
      return;
    }
    if (dirty && loadedSlugRef.current && slug !== loadedSlugRef.current) {
      pendingRevertSlugRef.current = loadedSlugRef.current;
      loadedSlugRef.current = null;
      setPendingCommunitySlug(slug);
      return;
    }
    const key = `${slug}|${communityVersion}`;
    if (lastLoadedKeyRef.current === key) {
      return;
    }
    lastLoadedKeyRef.current = key;
    void loadData(slug);
  }, [slug, communityVersion, hasAccess, dirty, pendingCommunitySlug, loadData]);

  const handleCancelCommunitySwitch = () => {
    const revertTo = pendingRevertSlugRef.current;
    pendingRevertSlugRef.current = null;
    setPendingCommunitySlug(null);
    if (revertTo) {
      loadedSlugRef.current = revertTo;
      setLoadedCommunitySlug(revertTo);
      cancellingSwitchRef.current = true;
      setSlug(revertTo);
    }
  };

  const handleConfirmCommunitySwitch = () => {
    pendingRevertSlugRef.current = null;
    setPendingCommunitySlug(null);
    setDirty(false);
    if (slug) {
      lastLoadedKeyRef.current = `${slug}|${communityVersion}`;
      void loadData(slug);
    }
  };

  const handleEditorChange = () => {
    setSavedMessage(null);
    if (!editorRef.current) {
      return;
    }
    const currentHtml = editorRef.current.getHTML();
    setDirty(currentHtml !== baselineRef.current);
  };

  const handleSave = async () => {
    if (savingRef.current || !slug || loadedSlugRef.current !== slug) {
      return;
    }

    const currentHtml = editorRef.current?.getHTML() ?? "";
    if (currentHtml.length > SERVICE_TIMES_HTML_MAX) {
      setErrorMessage("This is too long to save. Shorten it and try again.");
      return;
    }

    savingRef.current = true;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const mine = ++saveGeneration.current;
      const outcome = await saveServiceTimes({
        communitySlug: slug,
        html: currentHtml,
        version: versionRef.current,
      });

      if (saveGeneration.current !== mine) {
        return;
      }

      if (outcome.kind === "ok") {
        editorRef.current?.setContent(outcome.data.html);
        versionRef.current = outcome.data.version;
        // Capture new baseline right after setContent
        const newBaseline = editorRef.current?.getHTML() ?? "";
        baselineRef.current = newBaseline;
        loadedSlugRef.current = slug;
        setLoadedCommunitySlug(slug);
        setDirty(false);
        setSavedMessage("Saved");
        setShowReload(false);
      } else if (outcome.kind === "conflict") {
        setErrorMessage(
          "Someone else saved a change first. Reload to see their text, or copy yours before you reload.",
        );
        setShowReload(true);
      } else if (outcome.kind === "over_cap") {
        setErrorMessage("This is too long to save. Shorten it and try again.");
      } else if (outcome.kind === "payment_required") {
        void refreshBilling();
        setErrorMessage("Read-only until billing is settled");
      } else if (outcome.kind === "forbidden") {
        setErrorMessage("You do not have permission to change this.");
      } else {
        setErrorMessage("Could not save. Try again.");
      }
    } catch {
      setErrorMessage("Could not save. Try again.");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleReload = () => {
    if (pendingCommunitySlug !== null) {
      return;
    }
    saveGeneration.current++;
    if (slug) {
      void loadData(slug);
    }
  };

  if (!hasAccess) {
    return (
      <div className="flex flex-col gap-4">
        <ScreenTitle>{term.plural}</ScreenTitle>
        <p>You do not have access to this page.</p>
      </div>
    );
  }

  const hintId = "service-times-hint";

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <ScreenTitle>{term.plural}</ScreenTitle>

      {(blocker.state === "blocked" || pendingCommunitySlug !== null) && (
        <div
          ref={blockerAlertRef}
          role="alertdialog"
          aria-labelledby="unsaved-changes-title"
          aria-describedby="unsaved-changes-desc"
          tabIndex={-1}
          className="outline-hidden"
        >
          <Alert variant="warning">
            <div className="flex flex-col gap-2">
              <span id="unsaved-changes-title" className="font-semibold">
                Unsaved changes
              </span>
              <span id="unsaved-changes-desc">
                You have unsaved changes. Are you sure you want to leave?
              </span>
              <div className="flex items-center gap-2 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (pendingCommunitySlug !== null) {
                      handleCancelCommunitySwitch();
                    }
                    if (blocker.state === "blocked") {
                      blocker.reset();
                    }
                  }}
                >
                  Stay
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    if (pendingCommunitySlug !== null) {
                      handleConfirmCommunitySwitch();
                    }
                    if (blocker.state === "blocked") {
                      blocker.proceed();
                    }
                  }}
                >
                  Leave without saving
                </Button>
              </div>
            </div>
          </Alert>
        </div>
      )}

      {errorMessage && (
        <Alert variant="warning">
          <div className="flex items-center justify-between gap-4">
            <span>{errorMessage}</span>
            {showReload && (
              <Button
                type="button"
                variant="secondary"
                aria-label="Reload and discard local edits"
                disabled={pendingCommunitySlug !== null}
                onClick={handleReload}
              >
                Reload
              </Button>
            )}
          </div>
        </Alert>
      )}

      {savedMessage && (
        <div role="status" aria-live="polite" className="text-sm font-medium text-primary">
          {savedMessage}
        </div>
      )}

      {isLoading && (
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Loading...
        </div>
      )}

      <Panel>
        <div className="flex flex-col gap-2">
          <RichTextEditor
            ref={editorRef}
            label={term.fieldLabel}
            toolbarLabel="Formatting tools"
            toolbar={{
              heading2: "Heading 2",
              heading3: "Heading 3",
              bold: "Bold",
              italic: "Italic",
              bulletList: "Bullet list",
              orderedList: "Numbered list",
            }}
            placeholder={term.placeholder}
            describedBy={hintId}
            maxLength={SERVICE_TIMES_HTML_MAX}
            counterLabel={(used, max) => `${used} / ${max}`}
            disabled={!isReady || isLoading || isSaving}
            onChange={handleEditorChange}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {term.hint}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={!isReady || isLoading || isSaving}
            onClick={() => void handleSave()}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
