import "@community-hub/ui/rich-text-editor.css";

import { terminology } from "@community-hub/faith-church";
import { Alert, Button } from "@community-hub/ui";
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

  const { slug, version: communityVersion } = useCommunity();
  const { refresh: refreshBilling } = useBillingStatus();

  const editorRef = useRef<RichTextEditorHandle>(null);
  const baselineRef = useRef<string>("");
  const versionRef = useRef<number>(0);
  const loadGeneration = useRef<number>(0);
  const saveGeneration = useRef<number>(0);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const savingRef = useRef<boolean>(false);
  const blockerAlertRef = useRef<HTMLDivElement>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [dirty, setDirty] = useState<boolean>(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showReload, setShowReload] = useState<boolean>(false);

  // In-app navigation blocker
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (blocker.state === "blocked") {
      blockerAlertRef.current?.focus();
    }
  }, [blocker.state]);

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
        setDirty(false);
        setSavedMessage(null);
      } else if (outcome.kind === "forbidden") {
        setErrorMessage("You do not have permission to view this.");
      } else {
        setErrorMessage("Could not load. Try again.");
      }
    } catch {
      if (loadGeneration.current === mine) {
        setErrorMessage("Could not load. Try again.");
      }
    } finally {
      if (loadGeneration.current === mine) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!slug || !hasAccess) {
      setIsLoading(false);
      return;
    }
    const key = `${slug}|${communityVersion}`;
    if (lastLoadedKeyRef.current === key) {
      return;
    }
    lastLoadedKeyRef.current = key;
    void loadData(slug);
  }, [slug, communityVersion, hasAccess, loadData]);

  const handleEditorChange = () => {
    setSavedMessage(null);
    if (!editorRef.current) {
      return;
    }
    const currentHtml = editorRef.current.getHTML();
    setDirty(currentHtml !== baselineRef.current);
  };

  const handleSave = async () => {
    if (savingRef.current || !slug) {
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

      {blocker.state === "blocked" && (
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
                <Button type="button" variant="secondary" onClick={() => blocker.reset()}>
                  Stay
                </Button>
                <Button type="button" variant="destructive" onClick={() => blocker.proceed()}>
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
          disabled={isLoading || isSaving}
          onChange={handleEditorChange}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {term.hint}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" disabled={isLoading || isSaving} onClick={() => void handleSave()}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
