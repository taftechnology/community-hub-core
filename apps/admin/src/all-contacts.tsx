import {
  Alert,
  Avatar,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  EmptyState,
  Field,
  FilterBar,
  Pagination,
  Panel,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { usePeopleAccess } from "./people-access";
import { type ContactFormData, ContactFields, initialFormData } from "./contact-fields";
import { duplicateDeletedMessage, readErrorCode } from "./duplicate-deleted";
import { ScreenTitle } from "./screen-title";

export const PERSON_SOURCES = [
  "manual",
  "family_records",
  "website",
  "form",
  "donation",
  "event_rsvp",
  "event_booking",
  "volunteer_application",
  "mobile_app",
  "mobile_app_family",
  "auto",
] as const;

export type PersonSource = (typeof PERSON_SOURCES)[number];

export const PERSON_SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  family_records: "Family Records",
  website: "Website",
  form: "Form",
  donation: "Donation",
  event_rsvp: "Event RSVP",
  event_booking: "Event Booking",
  volunteer_application: "Volunteer Application",
  mobile_app: "Mobile App",
  mobile_app_family: "Mobile App Family",
  auto: "Auto",
};

type ContactItem = {
  id: string;
  givenName: string;
  familyName: string;
  version: number;
  email: string | null;
  phone: string | null;
  age: number | null;
  createdAt: string;
  status: "active" | "inactive";
  source: string;
  groups?: { id: string; name: string }[] | undefined;
  deletedAt?: string | undefined;
  purgeAfter?: string | undefined;
};

type ListResponse = {
  items: ContactItem[];
  nextCursor: string | null;
};

type DeleteTarget = {
  id: string;
  givenName: string;
  familyName: string;
  version: number;
  purgeOn: string;
};

type SummaryData = {
  total: number;
  active: number;
  inactive: number;
  addedSince: number;
  groups?: { id: string; name: string }[] | undefined;
};

type PersonDetail = {
  personId: string;
  isMinor: boolean;
  isAdultConfirmed: boolean;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  version: number;
  status: "active" | "inactive";
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseContactItem(item: unknown): ContactItem | null {
  if (!isRecord(item) || typeof item.id !== "string") {
    return null;
  }
  return {
    id: item.id,
    givenName: typeof item.givenName === "string" ? item.givenName : "",
    familyName: typeof item.familyName === "string" ? item.familyName : "",
    version: typeof item.version === "number" ? item.version : 1,
    email: typeof item.email === "string" ? item.email : null,
    phone: typeof item.phone === "string" ? item.phone : null,
    age: typeof item.age === "number" ? item.age : null,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    status: item.status === "inactive" ? "inactive" : "active",
    source: typeof item.source === "string" ? item.source : "",
    groups: Array.isArray(item.groups)
      ? item.groups
          .filter(isRecord)
          .map((g) => ({
            id: typeof g.id === "string" ? g.id : "",
            name: typeof g.name === "string" ? g.name : "",
          }))
          .filter((g) => g.id && g.name)
      : undefined,
    deletedAt: typeof item.deletedAt === "string" ? item.deletedAt : undefined,
    purgeAfter: typeof item.purgeAfter === "string" ? item.purgeAfter : undefined,
  };
}

function parseListResponse(value: unknown, kind?: "adults" | "minors"): ListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: ContactItem[] = [];
  for (const item of value.items) {
    if (kind === "adults" && isRecord(item) && item.isMinor === true) {
      continue;
    }
    const parsed = parseContactItem(item);
    if (parsed !== null) {
      items.push(parsed);
    }
  }
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
  return { items, nextCursor };
}

function parsePersonDetail(value: unknown): PersonDetail | null {
  if (!isRecord(value) || typeof value.personId !== "string") {
    return null;
  }
  return {
    personId: value.personId,
    isMinor: Boolean(value.isMinor),
    isAdultConfirmed: value.isMinor === false,
    givenName: typeof value.givenName === "string" ? value.givenName : "",
    familyName: typeof value.familyName === "string" ? value.familyName : "",
    email: typeof value.email === "string" ? value.email : null,
    phone: typeof value.phone === "string" ? value.phone : null,
    dateOfBirth: typeof value.dateOfBirth === "string" ? value.dateOfBirth : null,
    version: typeof value.version === "number" ? value.version : 1,
    status: value.status === "inactive" ? "inactive" : "active",
    source: typeof value.source === "string" ? value.source : "",
  };
}

function parseSummary(data: unknown): SummaryData | null {
  if (!isRecord(data)) {
    return null;
  }
  if (
    typeof data.total !== "number" ||
    typeof data.active !== "number" ||
    typeof data.inactive !== "number" ||
    typeof data.addedSince !== "number"
  ) {
    return null;
  }
  const result: SummaryData = {
    total: data.total,
    active: data.active,
    inactive: data.inactive,
    addedSince: data.addedSince,
  };
  if (Array.isArray(data.groups)) {
    result.groups = data.groups
      .filter(isRecord)
      .map((g) => ({
        id: typeof g.id === "string" ? g.id : "",
        name: typeof g.name === "string" ? g.name : "",
      }))
      .filter((g) => g.id && g.name);
  }
  return result;
}

const PURGE_AFTER_HOURS = 720;

const MESSAGE_CHANGED = "This contact was changed. Reload and try again.";
const MESSAGE_PURGED = "This contact was deleted permanently.";

const DELETE_REFUSALS: Record<string, string> = {
  linked_user: "This contact is linked to a user account. Remove the user first.",
  pending_invitation: "This contact has a pending invitation. Cancel it first.",
  sole_guardian:
    "This contact is the only guardian of a child. Add another guardian in Family Records first.",
};

function getBrowserMonthStartIso(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetStr = `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01T00:00:00${offsetStr}`;
}

function formatDate(dateString: string): string {
  if (!dateString) {
    return "None";
  }
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) {
      return "None";
    }
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d);
  } catch {
    return "None";
  }
}

export function AllContactsPage() {
  const token = readAccessToken();
  const { slug, version } = useCommunity();
  const { access } = usePeopleAccess();
  const { status, readiness, refresh: refreshBilling } = useBillingStatus();

  const [activeTab, setActiveTab] = useState<"adults" | "minors">("adults");
  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const [items, setItems] = useState<ContactItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [paymentRequired, setPaymentRequired] = useState(false);

  // Summary state
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(false);

  // Status toggle state
  const [savingStatusId, setSavingStatusId] = useState<string | null>(null);
  const savingStatusRef = useRef(false);
  const [statusAlert, setStatusAlert] = useState<string | null>(null);

  // Delete dialog and Restore state
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const lastDeleteTargetRef = useRef<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const deletePendingRef = useRef(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restoringRef = useRef(false);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const [focusAfterChange, setFocusAfterChange] = useState<"trigger" | "heading" | null>(null);

  // View state: "list" | "detail" | "add" | "edit"
  const [view, setView] = useState<"list" | "detail" | "add" | "edit">("list");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [detailPerson, setDetailPerson] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const [detailError, setDetailError] = useState(false);

  // Add & Edit form fields
  const [addForm, setAddForm] = useState<ContactFormData>(initialFormData);
  const [addSource, setAddSource] = useState("manual");
  const [addNotice, setAddNotice] = useState<string | null>(null);

  const [editForm, setEditForm] = useState<ContactFormData>(initialFormData);
  const [editSource, setEditSource] = useState("manual");
  const [editConflict, setEditConflict] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const addHeadingRef = useRef<HTMLHeadingElement>(null);
  const editHeadingRef = useRef<HTMLHeadingElement>(null);
  const addAlertRef = useRef<HTMLDivElement>(null);
  const editAlertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view === "list") {
      listHeadingRef.current?.focus();
    } else if (view === "detail") {
      detailHeadingRef.current?.focus();
    } else if (view === "add") {
      addHeadingRef.current?.focus();
    } else if (view === "edit") {
      editHeadingRef.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (addNotice) {
      addAlertRef.current?.focus();
    }
  }, [addNotice]);

  useEffect(() => {
    if (editNotice || editConflict) {
      editAlertRef.current?.focus();
    }
  }, [editNotice, editConflict]);

  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const isReadOnly = status?.state === "none" || status?.state === "read_only" || paymentRequired;
  const hideWrites = readiness === "loading" || isReadOnly;
  const canDelete = access.permissions["people.delete"];
  const deletedView = activeTab === "adults" && statusFilter === "deleted";

  const fetchContacts = useCallback(
    async (
      communitySlug: string,
      kind: "adults" | "minors",
      searchTerm: string,
      statusVal: string,
      sourceVal: string,
      groupVal: string,
      cursorToken: string | undefined,
      isCurrent: () => boolean,
    ) => {
      setLoading(true);

      const body: Record<string, unknown> = {
        communitySlug,
        kind,
      };
      if (kind === "adults") {
        if (searchTerm) {
          body.search = searchTerm;
        }
        if (statusVal) {
          body.status = statusVal;
        }
        // The Deleted list takes a name search only.
        if (sourceVal && statusVal !== "deleted") {
          body.source = sourceVal;
        }
        if (groupVal && statusVal !== "deleted") {
          body.groupId = groupVal;
        }
      }
      if (cursorToken) {
        body.cursor = cursorToken;
      }

      const response = await post("/v1/people/list", body);
      if (!isCurrent()) {
        return;
      }
      setLoading(false);

      if (response === "unavailable") {
        setError(true);
        return;
      }

      if (response.status === 402) {
        setItems(null);
        setPaymentRequired(true);
        void refreshBilling();
        return;
      }

      if (response.status !== 200) {
        setError(true);
        return;
      }

      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parseListResponse(data, kind);
        if (parsed === null) {
          setError(true);
          return;
        }
        setItems(parsed.items);
        setNextCursor(parsed.nextCursor);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setError(true);
      }
    },
    [refreshBilling],
  );

  const fetchSummary = useCallback(async (communitySlug: string, isCurrent: () => boolean) => {
    setSummaryLoading(true);
    const addedSince = getBrowserMonthStartIso();
    const response = await post("/v1/people/summary", { communitySlug, addedSince });
    if (!isCurrent()) {
      return;
    }
    setSummaryLoading(false);

    if (response === "unavailable" || response.status !== 200) {
      setSummaryError(true);
      setSummary(null);
      setGroupFilter("");
      return;
    }

    try {
      const data: unknown = await response.json();
      if (!isCurrent()) {
        return;
      }
      const parsed = parseSummary(data);
      if (parsed === null) {
        setSummaryError(true);
        setSummary(null);
        setGroupFilter("");
        return;
      }
      setSummary(parsed);
      setSummaryError(false);
      if (parsed.groups === undefined) {
        setGroupFilter("");
      }
    } catch {
      if (!isCurrent()) {
        return;
      }
      setSummaryError(true);
      setSummary(null);
      setGroupFilter("");
    }
  }, []);

  const reload = useCallback(() => {
    const mine = ++generation.current;
    if (!slug || !access.entitlements["people.directory"] || !access.permissions["people.view"]) {
      return;
    }
    setError(false);
    void fetchContacts(
      slug,
      activeTab,
      submittedSearch,
      statusFilter,
      sourceFilter,
      groupFilter,
      cursor,
      () => generation.current === mine,
    );
  }, [
    slug,
    activeTab,
    submittedSearch,
    statusFilter,
    sourceFilter,
    groupFilter,
    cursor,
    fetchContacts,
    access.entitlements["people.directory"],
    access.permissions["people.view"],
  ]);

  const previousSlugRef = useRef<string | null>(null);
  const summarySlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) {
      setItems(null);
      previousSlugRef.current = null;
      summarySlugRef.current = null;
      return;
    }
    if (previousSlugRef.current !== slug) {
      previousSlugRef.current = slug;
      summarySlugRef.current = null;
      setActiveTab("adults");
      setSearchDraft("");
      setSubmittedSearch("");
      setStatusFilter("");
      setSourceFilter("");
      setGroupFilter("");
      setCursor(undefined);
      setNextCursor(null);
      setItems(null);
      setSummary(null);
      setSummaryError(false);
      setStatusAlert(null);
      setDeleteTarget(null);
      setDeleteError(null);
      setDeletePending(false);
      deletePendingRef.current = false;
      setRestoringId(null);
      restoringRef.current = false;
      setFocusAfterChange(null);
      setView("list");
      setSelectedPersonId(null);
      setDetailPerson(null);
      detailGeneration.current += 1;
      setDetailNotFound(false);
      setDetailError(false);
      setAddForm(initialFormData);
      setAddSource("manual");
      setAddNotice(null);
      setEditForm(initialFormData);
      setEditSource("manual");
      setEditConflict(false);
      setEditNotice(null);
      setPaymentRequired(false);
      setError(false);
      submittingRef.current = false;
      setSubmitting(false);
      if (access.entitlements["people.directory"] && access.permissions["people.view"]) {
        summarySlugRef.current = slug;
        const mine = ++generation.current;
        void fetchContacts(
          slug,
          "adults",
          "",
          "",
          "",
          "",
          undefined,
          () => generation.current === mine,
        );
        void fetchSummary(slug, () => generation.current === mine);
      }
      return;
    }
    if (!access.entitlements["people.directory"] || !access.permissions["people.view"]) {
      return;
    }
    reload();

    if (activeTab === "adults" && summarySlugRef.current !== slug) {
      summarySlugRef.current = slug;
      const mine = generation.current;
      void fetchSummary(slug, () => generation.current === mine);
    }
  }, [
    slug,
    version,
    activeTab,
    reload,
    access.entitlements["people.directory"],
    access.permissions["people.view"],
    fetchContacts,
    fetchSummary,
  ]);

  useEffect(() => {
    if (summary?.groups === undefined && groupFilter) {
      setGroupFilter("");
    }
  }, [summary?.groups, groupFilter]);

  useEffect(() => {
    if (statusFilter === "deleted" && !canDelete) {
      setStatusFilter("");
      setItems(null);
      setCursor(undefined);
    }
  }, [statusFilter, canDelete]);

  // After a delete or restore the row is gone, so focus goes to the heading once the list is back.
  // After Cancel or Escape it returns to the Delete button of the row.
  useEffect(() => {
    if (focusAfterChange === null || deleteTarget !== null || loading || view !== "list") {
      return;
    }
    const trigger = deleteTriggerRef.current;
    if (focusAfterChange === "trigger" && trigger?.isConnected) {
      trigger.focus();
    } else {
      listHeadingRef.current?.focus();
    }
    setFocusAfterChange(null);
  }, [focusAfterChange, deleteTarget, loading, view]);

  const loadPersonDetail = useCallback(
    async (
      communitySlug: string,
      personId: string,
      isCurrent: () => boolean,
      options?: { syncEditForm?: boolean },
    ) => {
      setDetailLoading(true);
      setDetailNotFound(false);
      setDetailError(false);

      const response = await post("/v1/people/read", { communitySlug, personId });
      if (!isCurrent()) {
        return;
      }
      setDetailLoading(false);

      if (response === "unavailable") {
        setDetailError(true);
        return;
      }

      if (response.status === 404) {
        setDetailNotFound(true);
        return;
      }

      if (response.status !== 200) {
        setDetailError(true);
        return;
      }

      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parsePersonDetail(data);
        if (parsed === null) {
          setDetailError(true);
          return;
        }
        setDetailPerson(parsed);
        if (options?.syncEditForm) {
          setEditForm({
            givenName: parsed.givenName,
            familyName: parsed.familyName,
            email: parsed.email || "",
            phone: parsed.phone || "",
            dateOfBirth: parsed.dateOfBirth || "",
          });
          if (parsed.source === "manual" || parsed.source === "family_records") {
            setEditSource(parsed.source);
          } else {
            setEditSource("keep");
          }
          setEditConflict(false);
          setView("edit");
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        setDetailError(true);
      }
    },
    [],
  );

  const openDetail = useCallback(
    (personId: string) => {
      setSelectedPersonId(personId);
      setView("detail");
      setDetailPerson(null);
      const mine = ++detailGeneration.current;
      if (slug) {
        void loadPersonDetail(slug, personId, () => detailGeneration.current === mine);
      }
    },
    [slug, loadPersonDetail],
  );

  function reloadDetail() {
    if (selectedPersonId && slug) {
      const mine = ++detailGeneration.current;
      const syncEditForm = view === "edit";
      void loadPersonDetail(slug, selectedPersonId, () => detailGeneration.current === mine, {
        syncEditForm,
      });
    }
  }

  function openAdd() {
    setAddNotice(null);
    setAddForm(initialFormData);
    setAddSource("manual");
    setView("add");
  }

  function openEdit(person: PersonDetail) {
    setEditForm({
      givenName: person.givenName,
      familyName: person.familyName,
      email: person.email || "",
      phone: person.phone || "",
      dateOfBirth: person.dateOfBirth || "",
    });
    if (person.source === "manual" || person.source === "family_records") {
      setEditSource(person.source);
    } else {
      setEditSource("keep");
    }
    setEditConflict(false);
    setEditNotice(null);
    setView("edit");
  }

  function backToList() {
    setAddForm(initialFormData);
    setAddSource("manual");
    setEditForm(initialFormData);
    setEditSource("manual");
    setView("list");
    setSelectedPersonId(null);
    setDetailPerson(null);
    reload();
  }

  async function handleStatusToggle(person: ContactItem) {
    if (savingStatusRef.current || !slug) {
      return;
    }
    savingStatusRef.current = true;
    const newStatus = person.status === "active" ? "inactive" : "active";
    setSavingStatusId(person.id);
    setStatusAlert(null);

    try {
      const response = await post("/v1/people/status", {
        communitySlug: slug,
        personId: person.id,
        version: person.version,
        status: newStatus,
      });

      if (response === "unavailable") {
        setStatusAlert("Unable to update contact status");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setStatusAlert("Unable to update contact status");
        return;
      }

      if (response.status === 409) {
        setStatusAlert(
          "This contact was changed by someone else. Reloading to see the latest details.",
        );
        reload();
        return;
      }

      if (response.status !== 200) {
        setStatusAlert("Unable to update contact status");
        return;
      }

      try {
        const data: unknown = await response.json();
        if (isRecord(data) && typeof data.version === "number" && typeof data.status === "string") {
          setItems((prev) =>
            prev
              ? prev.map((item) =>
                  item.id === person.id
                    ? {
                        ...item,
                        version: data.version as number,
                        status: data.status === "inactive" ? "inactive" : "active",
                      }
                    : item,
                )
              : null,
          );
          if (slug) {
            const mine = generation.current;
            void fetchSummary(slug, () => generation.current === mine);
          }
        } else {
          setStatusAlert("Unable to update contact status");
        }
      } catch {
        setStatusAlert("Unable to update contact status");
      }
    } finally {
      savingStatusRef.current = false;
      setSavingStatusId(null);
    }
  }

  function openDeleteDialog(person: ContactItem, trigger: HTMLElement) {
    deleteTriggerRef.current = trigger;
    const purgeOn = formatDate(
      new Date(Date.now() + PURGE_AFTER_HOURS * 60 * 60 * 1000).toISOString(),
    );
    const target: DeleteTarget = {
      id: person.id,
      givenName: person.givenName,
      familyName: person.familyName,
      version: person.version,
      purgeOn,
    };
    lastDeleteTargetRef.current = target;
    setDeleteError(null);
    setDeleteTarget(target);
  }

  function closeDeleteDialog() {
    if (deletePendingRef.current) {
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
    setFocusAfterChange("trigger");
  }

  function refreshSummary() {
    if (slug) {
      const mine = generation.current;
      void fetchSummary(slug, () => generation.current === mine);
    }
  }

  async function handleDeleteConfirm() {
    const target = deleteTarget;
    if (target === null || deletePendingRef.current || !slug) {
      return;
    }
    const requestSlug = slug;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteError(null);

    try {
      const response = await post("/v1/people/delete", {
        communitySlug: requestSlug,
        personId: target.id,
        version: target.version,
      });
      if (previousSlugRef.current !== requestSlug) {
        return;
      }

      if (response === "unavailable") {
        setDeleteError("Unable to delete contact");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setDeleteTarget(null);
        setStatusAlert("Unable to delete contact");
        setFocusAfterChange("heading");
        return;
      }

      if (response.status === 404) {
        setDeleteTarget(null);
        setStatusAlert(MESSAGE_PURGED);
        reload();
        refreshSummary();
        setFocusAfterChange("heading");
        return;
      }

      if (response.status === 409) {
        const code = await readErrorCode(response);
        if (previousSlugRef.current !== requestSlug) {
          return;
        }
        setDeleteError((code !== null ? DELETE_REFUSALS[code] : undefined) ?? MESSAGE_CHANGED);
        return;
      }

      if (response.status !== 200) {
        setDeleteError("Unable to delete contact");
        return;
      }

      setDeleteTarget(null);
      setStatusAlert(null);
      reload();
      refreshSummary();
      setFocusAfterChange("heading");
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  }

  async function handleRestore(person: ContactItem) {
    if (restoringRef.current || !slug) {
      return;
    }
    const requestSlug = slug;
    restoringRef.current = true;
    setRestoringId(person.id);
    setStatusAlert(null);

    try {
      const response = await post("/v1/people/restore", {
        communitySlug: requestSlug,
        personId: person.id,
        version: person.version,
      });
      if (previousSlugRef.current !== requestSlug) {
        return;
      }

      if (response === "unavailable") {
        setStatusAlert("Unable to restore contact");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setStatusAlert("Unable to restore contact");
        return;
      }

      if (response.status === 404) {
        setStatusAlert(MESSAGE_PURGED);
        reload();
        setFocusAfterChange("heading");
        return;
      }

      if (response.status === 409) {
        setStatusAlert(MESSAGE_CHANGED);
        return;
      }

      if (response.status !== 200) {
        setStatusAlert("Unable to restore contact");
        return;
      }

      reload();
      refreshSummary();
      setFocusAfterChange("heading");
    } finally {
      restoringRef.current = false;
      setRestoringId(null);
    }
  }

  async function handleAddSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !slug) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setAddNotice(null);

    try {
      const body: Record<string, unknown> = {
        communitySlug: slug,
        givenName: addForm.givenName.trim(),
        familyName: addForm.familyName.trim(),
        source: addSource,
      };
      if (addForm.email.trim()) {
        body.email = addForm.email.trim();
      }
      if (addForm.phone.trim()) {
        body.phone = addForm.phone.trim();
      }
      if (addForm.dateOfBirth.trim()) {
        body.dateOfBirth = addForm.dateOfBirth.trim();
      }

      const response = await post("/v1/people/create", body);
      if (response === "unavailable" || response.status === 402) {
        if (response !== "unavailable" && response.status === 402) {
          setPaymentRequired(true);
          void refreshBilling();
        }
        setAddNotice("Unable to save contact");
        return;
      }

      if (response.status === 201) {
        backToList();
        return;
      }

      if (response.status === 409) {
        const code = await readErrorCode(response);
        setAddNotice(
          code === "duplicate_deleted"
            ? duplicateDeletedMessage(canDelete)
            : "Unable to save contact",
        );
        return;
      }

      setAddNotice("Unable to save contact");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !slug || !detailPerson) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setEditConflict(false);
    setEditNotice(null);

    try {
      const body: Record<string, unknown> = {
        communitySlug: slug,
        personId: detailPerson.personId,
        version: detailPerson.version,
        givenName: editForm.givenName.trim(),
        familyName: editForm.familyName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        dateOfBirth: editForm.dateOfBirth.trim() || null,
      };
      if (editSource === "manual" || editSource === "family_records") {
        body.source = editSource;
      }

      const response = await post("/v1/people/update", body);
      if (response === "unavailable") {
        setEditNotice("Unable to save changes");
        return;
      }

      if (response.status === 409) {
        const code = await readErrorCode(response);
        if (code === "duplicate_deleted") {
          setEditNotice(duplicateDeletedMessage(canDelete));
          return;
        }
        setEditConflict(true);
        return;
      }

      if (response.status === 404) {
        setDetailNotFound(true);
        setView("detail");
        return;
      }

      if (response.status === 200) {
        openDetail(detailPerson.personId);
        return;
      }

      setEditNotice("Unable to save changes");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleTabChange(tab: "adults" | "minors") {
    if (tab === activeTab) {
      return;
    }
    setActiveTab(tab);
    setCursor(undefined);
    setSearchDraft("");
    setSubmittedSearch("");
    setStatusFilter("");
    setSourceFilter("");
    setGroupFilter("");
    setItems(null);
    setStatusAlert(null);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(searchDraft.trim());
    setCursor(undefined);
  }

  function handleStatusFilterChange(val: string) {
    // The Deleted list and the adult list have different rows and cursors.
    if ((val === "deleted") !== (statusFilter === "deleted")) {
      setItems(null);
    }
    if (val === "deleted") {
      setSourceFilter("");
      setGroupFilter("");
    }
    setStatusFilter(val);
    setCursor(undefined);
    setStatusAlert(null);
  }

  function handleSourceFilterChange(val: string) {
    setSourceFilter(val);
    setCursor(undefined);
  }

  function handleGroupFilterChange(val: string) {
    setGroupFilter(val);
    setCursor(undefined);
  }

  function clearFilters() {
    if (statusFilter === "deleted") {
      setItems(null);
    }
    setStatusFilter("");
    setSourceFilter("");
    setGroupFilter("");
    setCursor(undefined);
  }

  function handleNextPage(token: string) {
    setCursor(token);
  }

  if (token === null) {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (!access.entitlements["people.directory"] || !access.permissions["people.view"]) {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  if (view === "detail") {
    const detailLoaded = !detailLoading && !detailNotFound && !detailError && detailPerson !== null;
    const canShowAvatar = detailLoaded && detailPerson.isAdultConfirmed;
    const canShowEdit =
      detailLoaded && !detailPerson.isMinor && access.permissions["people.manage"] && !hideWrites;
    const hasDetailActions = canShowAvatar || canShowEdit;

    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Button type="button" className="justify-self-start self-start" onClick={backToList}>
          Back to list
        </Button>

        <Panel
          title="Contact Details"
          level={2}
          headingRef={detailHeadingRef}
          headingTabIndex={-1}
          actions={
            hasDetailActions ? (
              <div className="flex items-center gap-2">
                {canShowAvatar ? (
                  <Avatar name={`${detailPerson.givenName} ${detailPerson.familyName}`} />
                ) : null}
                {canShowEdit ? (
                  <Button type="button" onClick={() => openEdit(detailPerson)}>
                    Edit contact
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {detailLoading ? (
            <>
              <Skeleton />
              <span className="sr-only">Loading contact details...</span>
            </>
          ) : null}

          {detailNotFound ? (
            <Alert live="polite">
              <span>Contact not found</span>
            </Alert>
          ) : null}

          {detailError ? (
            <Alert variant="destructive" live="assertive">
              <span>Failed to load contact</span>
              <Button type="button" onClick={reloadDetail}>
                Retry
              </Button>
            </Alert>
          ) : null}

          {detailLoaded ? (
            <DescriptionList
              items={[
                { term: "Given name:", value: detailPerson.givenName },
                { term: "Family name:", value: detailPerson.familyName },
                {
                  term: "Email:",
                  value: detailPerson.email ?? <span className="text-muted-foreground">None</span>,
                },
                {
                  term: "Phone:",
                  value: detailPerson.phone ?? <span className="text-muted-foreground">None</span>,
                },
                {
                  term: "Date of birth:",
                  value: detailPerson.dateOfBirth ?? (
                    <span className="text-muted-foreground">None</span>
                  ),
                },
              ]}
            />
          ) : null}
        </Panel>
      </>
    );
  }

  if (view === "add") {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Panel title="Add Contact" level={2} headingRef={addHeadingRef} headingTabIndex={-1}>
          {addNotice ? (
            <Alert ref={addAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{addNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleAddSubmit} className="grid gap-4">
            <ContactFields
              prefix="add"
              data={addForm}
              onChange={setAddForm}
              source={{
                value: addSource,
                onChange: setAddSource,
                options: [
                  { value: "manual", label: "Manual" },
                  { value: "family_records", label: "Family Records" },
                ],
              }}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save contact
              </Button>
              <Button type="button" variant="outline" onClick={backToList}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      </>
    );
  }

  if (view === "edit") {
    const editSourceOptions =
      detailPerson?.source === "manual" || detailPerson?.source === "family_records"
        ? [
            { value: "manual", label: "Manual" },
            { value: "family_records", label: "Family Records" },
          ]
        : [
            {
              value: "keep",
              label: `Keep current (${PERSON_SOURCE_LABELS[detailPerson?.source ?? ""] ?? (detailPerson?.source || "None")})`,
            },
            { value: "manual", label: "Manual" },
            { value: "family_records", label: "Family Records" },
          ];

    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Panel title="Edit Contact" level={2} headingRef={editHeadingRef} headingTabIndex={-1}>
          {editConflict ? (
            <Alert ref={editAlertRef} tabIndex={-1} role="alert">
              <span>
                This contact was changed by someone else, or that email or phone is already in use.
                Reload to see the latest details; your unsaved changes will be discarded.
              </span>
              <Button type="button" onClick={reloadDetail}>
                Reload
              </Button>
            </Alert>
          ) : null}

          {editNotice ? (
            <Alert ref={editAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{editNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleEditSubmit} className="grid gap-4">
            <ContactFields
              prefix="edit"
              data={editForm}
              onChange={setEditForm}
              source={{
                value: editSource,
                onChange: setEditSource,
                options: editSourceOptions,
              }}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save changes
              </Button>
              <Button type="button" variant="outline" onClick={() => setView("detail")}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      </>
    );
  }

  const hasFilters = Boolean(statusFilter || sourceFilter || groupFilter);

  const adultColumns: DataTableColumn<ContactItem>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      render: (person) => (
        <span className="flex items-center gap-2">
          <Avatar name={`${person.givenName} ${person.familyName}`} />
          <span>
            <span className="block font-semibold">
              <span>{person.givenName}</span> <span>{person.familyName}</span>
            </span>
            {person.age !== null ? (
              <span className="block text-sm text-muted-foreground font-normal">
                {`${person.age} years old`}
              </span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: "email",
      header: "Email",
      render: (person) =>
        person.email ? person.email : <span className="text-muted-foreground">None</span>,
    },
    {
      key: "phone",
      header: "Phone",
      render: (person) =>
        person.phone ? (
          <span className="whitespace-nowrap">{person.phone}</span>
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    {
      key: "date",
      header: "Date",
      render: (person) => <span className="whitespace-nowrap">{formatDate(person.createdAt)}</span>,
    },
    ...(summary?.groups !== undefined
      ? [
          {
            key: "groups",
            header: "Groups",
            render: (person: ContactItem) =>
              person.groups && person.groups.length > 0 ? (
                <span className="inline-flex flex-wrap gap-1">
                  {person.groups.map((grp) => (
                    <span
                      key={grp.id}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-foreground border border-border"
                    >
                      {grp.name}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">None</span>
              ),
          },
        ]
      : []),
    {
      key: "source",
      header: "Source",
      render: (person) => PERSON_SOURCE_LABELS[person.source] ?? (person.source || "None"),
    },
    {
      key: "status",
      header: "Status",
      render: (person) =>
        access.permissions["people.manage"] && !hideWrites ? (
          <Switch
            label={person.status === "active" ? "Active" : "Inactive"}
            aria-label={`${person.status === "active" ? "Active" : "Inactive"} status for ${person.givenName} ${person.familyName}`}
            checked={person.status === "active"}
            disabled={savingStatusId === person.id}
            onChange={() => void handleStatusToggle(person)}
          />
        ) : (
          <StatusBadge tone={person.status === "active" ? "success" : "neutral"}>
            {person.status === "active" ? "Active" : "Inactive"}
          </StatusBadge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (person) => (
        <span className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`View ${person.givenName} ${person.familyName}`}
            onClick={() => openDetail(person.id)}
          >
            View
          </Button>
          {canDelete && !hideWrites ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Delete ${person.givenName} ${person.familyName}`}
              onClick={(event) => openDeleteDialog(person, event.currentTarget)}
            >
              Delete
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  const deletedColumns: DataTableColumn<ContactItem>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      render: (person) => (
        <span className="block font-semibold">
          <span>{person.givenName}</span> <span>{person.familyName}</span>
        </span>
      ),
    },
    {
      key: "deleted",
      header: "Deleted",
      render: (person) =>
        person.deletedAt && person.purgeAfter ? (
          `Deleted ${formatDate(person.deletedAt)}, deleted permanently on ${formatDate(person.purgeAfter)}`
        ) : (
          <span className="text-muted-foreground">None</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (person) =>
        canDelete && !hideWrites ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Restore ${person.givenName} ${person.familyName}`}
            disabled={restoringId === person.id}
            onClick={() => void handleRestore(person)}
          >
            Restore
          </Button>
        ) : null,
    },
  ];

  const minorColumns: DataTableColumn<ContactItem>[] = [
    {
      key: "givenName",
      header: "Given name",
      primary: true,
      render: (person) => person.givenName,
    },
    {
      key: "familyName",
      header: "Family name",
      render: (person) => person.familyName,
    },
    {
      key: "actions",
      header: "Actions",
      render: (person) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`View ${person.givenName} ${person.familyName}`}
          onClick={() => openDetail(person.id)}
        >
          View
        </Button>
      ),
    },
  ];

  return (
    <>
      <ScreenTitle ref={listHeadingRef}>All Contacts</ScreenTitle>

      {isReadOnly ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>{" "}
          <Link to="/settings/general">General Settings</Link>
        </Alert>
      ) : null}

      <div role="group" aria-label="Contact types" className="flex flex-wrap gap-2">
        <Button
          type="button"
          aria-pressed={activeTab === "adults"}
          variant={activeTab === "adults" ? "default" : "outline"}
          onClick={() => handleTabChange("adults")}
        >
          Adults
        </Button>
        {access.permissions["people.restricted.read"] ? (
          <Button
            type="button"
            aria-pressed={activeTab === "minors"}
            variant={activeTab === "minors" ? "default" : "outline"}
            onClick={() => handleTabChange("minors")}
          >
            Minors
          </Button>
        ) : null}
      </div>

      <Panel
        actions={
          !loading &&
          !error &&
          items !== null &&
          access.permissions["people.manage"] &&
          !hideWrites &&
          activeTab === "adults" &&
          !deletedView &&
          (!submittedSearch || items.length > 0) ? (
            <Button type="button" onClick={openAdd}>
              Add contact
            </Button>
          ) : undefined
        }
        footer={
          !loading && !error && items !== null && items.length > 0 && nextCursor !== null ? (
            <Pagination cursor={nextCursor} onNext={handleNextPage} />
          ) : undefined
        }
      >
        {statusAlert ? (
          <Alert variant="destructive" role="alert" className="mb-4">
            <span>{statusAlert}</span>
          </Alert>
        ) : null}

        {activeTab === "adults" && !deletedView ? (
          summaryLoading && summary === null ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : summaryError ? (
            <Alert live="polite" className="mb-4">
              <span>Counts unavailable</span>
            </Alert>
          ) : summary !== null ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground font-medium">Total contacts</div>
                <div className="text-2xl font-semibold text-foreground mt-1">{summary.total}</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground font-medium">Active</div>
                <div className="text-2xl font-semibold text-foreground mt-1">{summary.active}</div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground font-medium">Inactive</div>
                <div className="text-2xl font-semibold text-foreground mt-1">
                  {summary.inactive}
                </div>
              </div>
              <div className="bg-card border border-border rounded-lg p-4">
                <div className="text-sm text-muted-foreground font-medium">Added this month</div>
                <div className="text-2xl font-semibold text-foreground mt-1">
                  {summary.addedSince}
                </div>
              </div>
            </div>
          ) : null
        ) : null}

        {activeTab === "adults" ? (
          <div className="flex flex-wrap gap-4 items-end mb-4">
            <FilterBar
              label="Search contacts"
              inputId="contact-search-input"
              value={searchDraft}
              onValueChange={setSearchDraft}
              onSubmit={handleSearchSubmit}
              className="flex-1 min-w-[200px]"
            />
            <div className="flex flex-wrap gap-2 items-end">
              <Field label="Status">
                <Select
                  id="contact-status-filter"
                  value={statusFilter}
                  onChange={(e) => handleStatusFilterChange(e.target.value)}
                >
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  {canDelete ? <option value="deleted">Deleted</option> : null}
                </Select>
              </Field>
              {deletedView ? null : (
                <Field label="Source">
                  <Select
                    id="contact-source-filter"
                    value={sourceFilter}
                    onChange={(e) => handleSourceFilterChange(e.target.value)}
                  >
                    <option value="">All sources</option>
                    {PERSON_SOURCES.map((src) => (
                      <option key={src} value={src}>
                        {PERSON_SOURCE_LABELS[src]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {summary?.groups !== undefined && !deletedView ? (
                <Field label="Group">
                  <Select
                    id="contact-group-filter"
                    value={groupFilter}
                    onChange={(e) => handleGroupFilterChange(e.target.value)}
                  >
                    <option value="">All groups</option>
                    {summary.groups.map((grp) => (
                      <option key={grp.id} value={grp.id}>
                        {grp.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive" live="assertive">
            <span>Failed to load contacts</span>
            <Button type="button" onClick={() => reload()}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {loading ? <Skeleton /> : null}

        {!loading && !error && items !== null ? (
          items.length === 0 ? (
            deletedView ? (
              <EmptyState message="No deleted contacts." />
            ) : hasFilters ? (
              <div className="grid justify-items-center gap-2 py-4">
                <EmptyState message="No contacts match these filters" />
                <Button type="button" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            ) : (
              <EmptyState message={submittedSearch ? "No contacts match" : "No contacts yet"} />
            )
          ) : (
            <DataTable
              aria-label="Contacts"
              rowKey={(person) => person.id}
              columns={
                deletedView ? deletedColumns : activeTab === "adults" ? adultColumns : minorColumns
              }
              rows={items}
            />
          )
        ) : null}
      </Panel>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteDialog();
          }
        }}
        title={`Delete ${(deleteTarget ?? lastDeleteTargetRef.current)?.givenName ?? ""} ${(deleteTarget ?? lastDeleteTargetRef.current)?.familyName ?? ""}?`}
        description={`They are hidden now and deleted permanently on ${(deleteTarget ?? lastDeleteTargetRef.current)?.purgeOn ?? ""}. Staff with the delete permission can restore them until then.`}
        confirmLabel="Delete contact"
        cancelLabel="Cancel"
        tone="danger"
        onConfirm={() => void handleDeleteConfirm()}
        pending={deletePending}
        {...(deleteError !== null ? { error: deleteError } : {})}
      />
    </>
  );
}
