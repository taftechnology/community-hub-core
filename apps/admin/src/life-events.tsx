import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  Skeleton,
  Textarea,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  createLifeEvent,
  type LifeEvent,
  type LifeEventType,
  listLifeEvents,
  updateLifeEvent,
} from "./api";
import { useCommunity } from "./community";

export type LifeEventsPanelProps = {
  personId: string;
  personName: string;
  isReadOnly?: boolean;
  canManage?: boolean;
};

const LIFE_EVENT_TYPES: { key: LifeEventType; label: string }[] = [
  { key: "baptism", label: "Baptism" },
  { key: "first_communion", label: "First Communion" },
  { key: "marriage", label: "Marriage" },
  { key: "funeral", label: "Funeral" },
  { key: "birth", label: "Birth" },
  { key: "death", label: "Death" },
  { key: "graduation", label: "Graduation" },
  { key: "anniversary", label: "Anniversary" },
  { key: "other", label: "Other" },
];

function formatType(type: string): string {
  const match = LIFE_EVENT_TYPES.find((t) => t.key === type);
  return match ? match.label : type;
}

export function LifeEventsPanel({
  personId,
  personName,
  isReadOnly = false,
  canManage = false,
}: LifeEventsPanelProps) {
  const { slug } = useCommunity();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LifeEvent[] | null>(null);

  const [formMode, setFormMode] = useState<"none" | "add" | "edit">("none");
  const [editingEvent, setEditingEvent] = useState<LifeEvent | null>(null);

  const [formType, setFormType] = useState<LifeEventType>("baptism");
  const [formDate, setFormDate] = useState("");
  const [formPlace, setFormPlace] = useState("");
  const [formNotes, setFormNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isConflict, setIsConflict] = useState(false);

  const generation = useRef(0);

  const loadEvents = useCallback(async () => {
    if (!slug || !personId) {
      setEvents([]);
      setLoading(false);
      return;
    }

    const currentGen = ++generation.current;
    setLoading(true);
    setError(null);

    const response = await listLifeEvents(slug, personId);

    if (generation.current !== currentGen) {
      return;
    }

    if (response === "unavailable" || !response.ok) {
      setError("Failed to load life events");
      setLoading(false);
      return;
    }

    try {
      const data = (await response.json()) as { items?: LifeEvent[] };
      if (generation.current !== currentGen) {
        return;
      }
      setEvents(data.items ?? []);
    } catch {
      if (generation.current !== currentGen) {
        return;
      }
      setError("Failed to load life events");
    } finally {
      if (generation.current === currentGen) {
        setLoading(false);
      }
    }
  }, [slug, personId]);

  useEffect(() => {
    void loadEvents();
    return () => {
      generation.current += 1;
    };
  }, [loadEvents]);

  function startAdd() {
    setFormMode("add");
    setEditingEvent(null);
    setFormType("baptism");
    setFormDate("");
    setFormPlace("");
    setFormNotes("");
    setActionError(null);
    setIsConflict(false);
  }

  function startEdit(event: LifeEvent) {
    setFormMode("edit");
    setEditingEvent(event);
    setFormType(event.type);
    setFormDate(event.date);
    setFormPlace(event.place ?? "");
    setFormNotes(event.notes ?? "");
    setActionError(null);
    setIsConflict(false);
  }

  function cancelForm() {
    setFormMode("none");
    setEditingEvent(null);
    setActionError(null);
    setIsConflict(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!slug || !personId) return;

    setSubmitting(true);
    setActionError(null);
    setIsConflict(false);

    if (formMode === "add") {
      const response = await createLifeEvent({
        communitySlug: slug,
        personId,
        type: formType,
        date: formDate,
        place: formPlace.trim() || null,
        notes: formNotes.trim() || null,
      });

      setSubmitting(false);

      if (response !== "unavailable" && response.status === 400) {
        setActionError("Check the date: it cannot be in the future or before 1900.");
        return;
      }

      if (response === "unavailable" || !response.ok) {
        setActionError("Failed to save life event");
        return;
      }

      setFormMode("none");
      await loadEvents();
    } else if (formMode === "edit" && editingEvent) {
      const response = await updateLifeEvent({
        communitySlug: slug,
        eventId: editingEvent.eventId,
        version: editingEvent.version,
        type: formType,
        date: formDate,
        place: formPlace.trim() || null,
        notes: formNotes.trim() || null,
      });

      setSubmitting(false);

      if (response !== "unavailable" && response.status === 409) {
        setIsConflict(true);
        return;
      }

      if (response !== "unavailable" && response.status === 400) {
        setActionError("Check the date: it cannot be in the future or before 1900.");
        return;
      }

      if (response === "unavailable" || !response.ok) {
        setActionError("Failed to save life event");
        return;
      }

      setFormMode("none");
      setEditingEvent(null);
      await loadEvents();
    }
  }

  async function handleRefreshConflict() {
    setIsConflict(false);
    setFormMode("none");
    setEditingEvent(null);
    await loadEvents();
  }

  const canEdit = canManage && !isReadOnly;

  return (
    <div data-testid={`life-events-panel-${personId}`}>
      <Panel
        title={`Life events: ${personName}`}
        level={4}
        actions={
          canEdit && formMode === "none" ? (
            <Button type="button" variant="outline" onClick={startAdd}>
              Add life event
            </Button>
          ) : null
        }
      >
        {loading && events === null ? (
          <>
            <Skeleton />
            <span className="sr-only">Loading life events...</span>
          </>
        ) : null}

        {error ? (
          <Alert variant="destructive" role="alert">
            <span>Failed to load life events</span>
            <Button type="button" onClick={() => void loadEvents()}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {isConflict ? (
          <Alert variant="destructive" role="alert">
            <span>
              This record was modified by someone else. Please refresh to see the latest changes.
            </span>
            <Button type="button" onClick={() => void handleRefreshConflict()}>
              Refresh
            </Button>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert variant="destructive" role="alert">
            <span>{actionError}</span>
          </Alert>
        ) : null}

        {formMode !== "none" ? (
          <form onSubmit={handleSubmit} className="grid gap-4 rounded-md border border-border p-3">
            <h5 className="font-medium text-sm">
              {formMode === "add" ? "Add Life Event" : "Edit Life Event"}
            </h5>
            <Field label="Event type">
              <Select
                id={`life-event-type-${personId}`}
                value={formType}
                onChange={(e) => setFormType(e.target.value as LifeEventType)}
                required
              >
                {LIFE_EVENT_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Date">
              <Input
                id={`life-event-date-${personId}`}
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                required
              />
            </Field>

            <Field label="Place">
              <Input
                id={`life-event-place-${personId}`}
                type="text"
                maxLength={200}
                value={formPlace}
                onChange={(e) => setFormPlace(e.target.value)}
              />
            </Field>

            <Field label="Notes">
              <Textarea
                id={`life-event-notes-${personId}`}
                maxLength={2000}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                rows={3}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                {formMode === "add" ? "Save life event" : "Save changes"}
              </Button>
              <Button type="button" variant="outline" onClick={cancelForm}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {!loading && !error && events !== null && events.length === 0 && formMode === "none" ? (
          <EmptyState message="No life events recorded" />
        ) : null}

        {!loading && !error && events !== null && events.length > 0 ? (
          <DataTable
            aria-label={`Life events for ${personName}`}
            rowKey={(event) => event.eventId}
            columns={[
              {
                key: "type",
                header: "Type",
                primary: true,
                render: (event) => formatType(event.type),
              },
              {
                key: "date",
                header: "Date",
                render: (event) => event.date,
              },
              {
                key: "place",
                header: "Place",
                render: (event) =>
                  event.place !== null ? (
                    event.place
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  ),
              },
              {
                key: "notes",
                header: "Notes",
                render: (event) =>
                  event.notes !== null ? (
                    event.notes
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  ),
              },
              ...(canEdit
                ? [
                    {
                      key: "actions",
                      header: "Actions",
                      render: (event: LifeEvent) => (
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Edit ${formatType(event.type)} for ${personName}`}
                          onClick={() => startEdit(event)}
                        >
                          Edit
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={events}
          />
        ) : null}
      </Panel>
    </div>
  );
}
