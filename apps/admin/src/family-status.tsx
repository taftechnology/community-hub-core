import {
  Button,
  ConfirmDialog,
  type DataTableColumn,
  Field,
  Select,
  StatusBadge,
  Switch,
} from "@community-hub/ui";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import { post } from "./api";
import { readErrorCode } from "./duplicate-deleted";

export type FamilyStatus = "active" | "inactive";
export type StatusFilter = "" | FamilyStatus | "deleted";

export type HouseholdItem = {
  householdId: string;
  version: number;
  label: string | null;
  adultCount: number;
  status: FamilyStatus;
  // Only on the Deleted list.
  deletedAt?: string;
  purgeAfter?: string;
};

export const MESSAGE_CHANGED = "Someone else changed this family. Reload and try again.";
export const MESSAGE_FAILED = "Unable to save. Try again.";
const MESSAGE_READ_ONLY = "Read-only until billing is settled";
const MESSAGE_HAS_CHILDREN = "This family has a child in it, so it can't be deleted.";
const MESSAGE_NOT_RESTORABLE =
  "This family can't be restored. It may already be restored or deleted permanently.";

const PURGE_AFTER_HOURS = 720;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A missing or unknown status is read as active, so a newer admin works against an older API.
export function readFamilyStatus(value: unknown): FamilyStatus {
  return value === "inactive" ? "inactive" : "active";
}

export function readStatusFilter(value: string): StatusFilter {
  return value === "active" || value === "inactive" || value === "deleted" ? value : "";
}

export function familyName(label: string | null): string {
  return label ?? "this family";
}

export function formatFamilyDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return "None";
  }
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

// A malformed deleted item is dropped, as the other parsers do it.
export function parseDeletedItem(item: unknown): HouseholdItem | null {
  if (
    !isRecord(item) ||
    typeof item.householdId !== "string" ||
    typeof item.version !== "number" ||
    !validDate(item.deletedAt) ||
    !validDate(item.purgeAfter)
  ) {
    return null;
  }
  return {
    householdId: item.householdId,
    version: item.version,
    label: typeof item.label === "string" ? item.label : null,
    adultCount: typeof item.adultCount === "number" ? item.adultCount : 0,
    status: "active",
    deletedAt: item.deletedAt,
    purgeAfter: item.purgeAfter,
  };
}

function isPastPurge(item: HouseholdItem): boolean {
  return item.purgeAfter !== undefined && new Date(item.purgeAfter).getTime() <= Date.now();
}

function parseStatusAnswer(value: unknown): { version: number; status: FamilyStatus } | null {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    (value.status !== "active" && value.status !== "inactive")
  ) {
    return null;
  }
  return { version: value.version, status: value.status };
}

export function StatusFilterSelect({
  value,
  onChange,
  canFilterDeleted,
}: {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
  canFilterDeleted: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 items-end">
      <Field label="Status">
        <Select
          id="family-status-filter"
          value={value}
          onChange={(e) => onChange(readStatusFilter(e.target.value))}
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          {canFilterDeleted ? <option value="deleted">Deleted</option> : null}
        </Select>
      </Field>
    </div>
  );
}

export function statusColumn(options: {
  canSwitch: boolean;
  pending: Record<string, FamilyStatus>;
  onToggle: (item: HouseholdItem) => void;
}): DataTableColumn<HouseholdItem> {
  return {
    key: "status",
    header: "Status",
    render: (household) => {
      const shown = options.pending[household.householdId] ?? household.status;
      const text = shown === "active" ? "Active" : "Inactive";
      const saving = household.householdId in options.pending;
      // While its save is open the switch stays focusable (aria-disabled, not disabled), so focus
      // is not lost to the page body; a click or key press then sends nothing.
      return options.canSwitch ? (
        <Switch
          label={text}
          aria-label={`${text} status for ${familyName(household.label)}`}
          checked={shown === "active"}
          {...(saving ? { "aria-disabled": true, "aria-busy": true } : {})}
          onChange={() => {
            if (!saving) {
              options.onToggle(household);
            }
          }}
        />
      ) : (
        <StatusBadge tone={shown === "active" ? "success" : "neutral"}>{text}</StatusBadge>
      );
    },
  };
}

export function deletedColumns(options: {
  canRestore: boolean;
  restoringId: string | null;
  onRestore: (item: HouseholdItem) => void;
}): DataTableColumn<HouseholdItem>[] {
  return [
    {
      key: "household",
      header: "Household",
      primary: true,
      render: (household) => household.label ?? <span className="text-muted-foreground">None</span>,
    },
    {
      key: "deleted",
      header: "Deleted",
      render: (household) => {
        const deleted = formatFamilyDate(household.deletedAt ?? "");
        return isPastPurge(household) ? (
          <span className="flex flex-wrap gap-x-2">
            <span>{`Deleted ${deleted}`}</span>
            <span>Permanent deletion pending</span>
          </span>
        ) : (
          `Deleted ${deleted}, deleted permanently on ${formatFamilyDate(household.purgeAfter ?? "")}`
        );
      },
    },
    {
      key: "actions",
      header: "Actions",
      render: (household) =>
        options.canRestore && !isPastPurge(household) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Restore ${familyName(household.label)}`}
            disabled={options.restoringId === household.householdId}
            onClick={() => options.onRestore(household)}
          >
            Restore
          </Button>
        ) : null,
    },
  ];
}

type ListActionParams = {
  slug: string;
  // Changes with the community and the status filter; an answer for an earlier one is ignored.
  scope: MutableRefObject<number>;
  // Changes with the community only.
  community: MutableRefObject<number>;
  statusFilter: StatusFilter;
  setItems: Dispatch<SetStateAction<HouseholdItem[] | null>>;
  setAlert: (message: string | null) => void;
  applyAnswer: (householdId: string, version: number, status: FamilyStatus) => void;
  reloadList: () => void;
  focusHeading: () => void;
  // Moves focus to the list alert once it is on screen.
  focusAlert: () => void;
  onPaymentRequired: () => void;
};

export function useFamilyListActions(params: ListActionParams) {
  const { slug, scope, community, statusFilter, setItems, setAlert } = params;
  const [pending, setPending] = useState<Record<string, FamilyStatus>>({});
  const saving = useRef(new Set<string>());
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restoring = useRef<string | null>(null);

  function reset() {
    saving.current.clear();
    restoring.current = null;
    setPending({});
    setRestoringId(null);
  }

  async function toggleStatus(item: HouseholdItem) {
    const id = item.householdId;
    if (saving.current.has(id) || !slug) {
      return;
    }
    const next: FamilyStatus = item.status === "active" ? "inactive" : "active";
    const mine = scope.current;
    const mineCommunity = community.current;
    // Another community: ignore. Same community but another filter: the row on screen may have
    // been loaded since, so reload the list once and say nothing.
    function superseded(): boolean {
      if (community.current !== mineCommunity) {
        return true;
      }
      if (scope.current !== mine) {
        params.reloadList();
        return true;
      }
      return false;
    }
    // A refused or failed change says why, and focus goes to that message.
    function refuse(message: string) {
      setAlert(message);
      params.focusAlert();
    }
    saving.current.add(id);
    setPending((prev) => ({ ...prev, [id]: next }));
    setAlert(null);

    try {
      const response = await post("/v1/households/status", {
        communitySlug: slug,
        householdId: id,
        version: item.version,
        status: next,
      });
      if (superseded()) {
        return;
      }
      if (response === "unavailable") {
        refuse(MESSAGE_FAILED);
        return;
      }
      if (response.status === 402) {
        params.onPaymentRequired();
        refuse(MESSAGE_READ_ONLY);
        return;
      }
      if (response.status === 409) {
        refuse(MESSAGE_CHANGED);
        return;
      }
      if (response.status !== 200) {
        refuse(MESSAGE_FAILED);
        return;
      }
      let answer: { version: number; status: FamilyStatus } | null = null;
      try {
        answer = parseStatusAnswer(await response.json());
      } catch {
        answer = null;
      }
      if (superseded()) {
        return;
      }
      if (answer === null) {
        refuse(MESSAGE_FAILED);
        return;
      }
      const { version, status } = answer;
      const leaves = statusFilter !== "" && statusFilter !== status;
      setItems((prev) =>
        prev === null
          ? null
          : leaves
            ? prev.filter((row) => row.householdId !== id)
            : prev.map((row) => (row.householdId === id ? { ...row, version, status } : row)),
      );
      params.applyAnswer(id, version, status);
      if (leaves) {
        params.focusHeading();
      }
    } finally {
      saving.current.delete(id);
      setPending((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    }
  }

  async function restore(item: HouseholdItem) {
    const id = item.householdId;
    if (restoring.current !== null || !slug) {
      return;
    }
    const mine = scope.current;
    // A refused or failed restore says why, and focus goes to that message.
    function refuse(message: string) {
      setAlert(message);
      params.focusAlert();
    }
    restoring.current = id;
    setRestoringId(id);
    setAlert(null);

    try {
      const response = await post("/v1/households/restore", {
        communitySlug: slug,
        householdId: id,
        version: item.version,
      });
      if (scope.current !== mine) {
        return;
      }
      if (response === "unavailable") {
        refuse(MESSAGE_FAILED);
        return;
      }
      if (response.status === 402) {
        params.onPaymentRequired();
        refuse(MESSAGE_READ_ONLY);
        return;
      }
      if (response.status === 404) {
        setAlert(MESSAGE_NOT_RESTORABLE);
        params.reloadList();
        params.focusHeading();
        return;
      }
      if (response.status === 409) {
        refuse(MESSAGE_CHANGED);
        return;
      }
      if (response.status !== 200) {
        refuse(MESSAGE_FAILED);
        return;
      }
      params.reloadList();
      params.focusHeading();
    } finally {
      if (restoring.current === id) {
        restoring.current = null;
        setRestoringId(null);
      }
    }
  }

  return { pending, restoringId, toggleStatus, restore, reset };
}

type DeleteTarget = { householdId: string; version: number; label: string | null; purgeOn: string };

type DeleteParams = {
  slug: string;
  // Changes when the community or the open family does; an answer for an earlier one is ignored.
  panel: MutableRefObject<number>;
  onDone: () => void;
  onPaymentRequired: () => void;
  focusFallback: () => void;
};

export function useFamilyDelete(params: DeleteParams) {
  const { slug, panel } = params;
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [refocus, setRefocus] = useState(false);

  // After Cancel or Escape focus returns to the Delete family button.
  useEffect(() => {
    if (!refocus || open) {
      return;
    }
    if (triggerRef.current?.isConnected) {
      triggerRef.current.focus();
    } else {
      params.focusFallback();
    }
    setRefocus(false);
  }, [refocus, open, params]);

  function reset() {
    pendingRef.current = false;
    setPending(false);
    setOpen(false);
    setError(null);
    setRefocus(false);
  }

  function openDialog(family: Omit<DeleteTarget, "purgeOn">, trigger: HTMLElement) {
    triggerRef.current = trigger;
    const purgeOn = formatFamilyDate(
      new Date(Date.now() + PURGE_AFTER_HOURS * 60 * 60 * 1000).toISOString(),
    );
    setTarget({ ...family, purgeOn });
    setError(null);
    setOpen(true);
  }

  // The key or write access to delete was lost while the dialog was open. A request that is already
  // sent stays sent and is not repeated; focus goes to the fallback once the dialog is gone.
  function close() {
    if (!open) {
      return;
    }
    setOpen(false);
    setError(null);
    setRefocus(true);
  }

  function cancel() {
    if (pendingRef.current) {
      return;
    }
    setOpen(false);
    setError(null);
    setRefocus(true);
  }

  async function confirm() {
    if (target === null || pendingRef.current || !slug) {
      return;
    }
    const mine = panel.current;
    let stale = false;
    pendingRef.current = true;
    setPending(true);
    setError(null);

    try {
      const response = await post("/v1/households/delete", {
        communitySlug: slug,
        householdId: target.householdId,
        version: target.version,
      });
      if (panel.current !== mine) {
        stale = true;
        return;
      }
      if (response === "unavailable") {
        setError(MESSAGE_FAILED);
        return;
      }
      if (response.status === 402) {
        params.onPaymentRequired();
        setError(MESSAGE_READ_ONLY);
        return;
      }
      if (response.status === 404) {
        setOpen(false);
        params.onDone();
        return;
      }
      if (response.status === 409) {
        const code = await readErrorCode(response);
        if (panel.current !== mine) {
          stale = true;
          return;
        }
        setError(code === "household_has_children" ? MESSAGE_HAS_CHILDREN : MESSAGE_CHANGED);
        return;
      }
      if (response.status !== 200) {
        setError(MESSAGE_FAILED);
        return;
      }
      setOpen(false);
      params.onDone();
    } finally {
      if (!stale) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  const dialog = (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          cancel();
        }
      }}
      title={`Delete ${familyName(target?.label ?? null)}?`}
      description={`It is hidden now and deleted permanently on ${target?.purgeOn ?? ""}. Its adults stay in All Contacts. Staff with the delete and restricted read permissions can restore it until then.`}
      confirmLabel="Delete family"
      cancelLabel="Cancel"
      tone="danger"
      onConfirm={() => void confirm()}
      pending={pending}
      {...(error !== null ? { error } : {})}
    />
  );

  return { dialog, openDialog, close, reset };
}
