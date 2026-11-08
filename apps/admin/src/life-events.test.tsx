import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LifeEvent, LifeEventType } from "./api";
import { CommunityProvider, useCommunity } from "./community";
import { LifeEventsPanel } from "./life-events";

function resultIds(
  results: axe.AxeResults,
  bucket: "passes" | "violations" | "incomplete" | "inapplicable",
): string[] {
  return results[bucket].map((entry) => entry.id);
}

const SLUG = "test-community";
const PERSON_ID = "00000000-0000-4000-8000-000000000010";
const TOKEN = "synthetic.access.token";

describe("LifeEventsPanel unit and accessibility tests", () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem("community-hub.access-token", TOKEN);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPanel(
    props: {
      personId?: string;
      personName?: string;
      isReadOnly?: boolean;
      canManage?: boolean;
      slug?: string;
    } = {},
  ) {
    sessionStorage.setItem("community-hub.community", props.slug ?? SLUG);
    return render(
      <CommunityProvider>
        <LifeEventsPanel
          personId={props.personId ?? PERSON_ID}
          personName={props.personName ?? "Arthur Clarke"}
          isReadOnly={props.isReadOnly ?? false}
          canManage={props.canManage ?? true}
        />
      </CommunityProvider>,
    );
  }

  it("empty state displays 'No life events recorded' and passes axe", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();

    expect(await screen.findByText("No life events recorded")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add life event/i })).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("lists life events for a member and passes axe", async () => {
    const sampleEvents: LifeEvent[] = [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        version: 1,
        type: "baptism",
        date: "2010-04-15",
        place: "St Stephen Parish",
        notes: "Godparents present",
      },
      {
        eventId: "00000000-0000-4000-8000-000000000002",
        version: 1,
        type: "first_communion",
        date: "2018-05-20",
        place: null,
        notes: null,
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: sampleEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();

    expect(await screen.findByText("Baptism")).toBeTruthy();
    expect(screen.getByText("2010-04-15")).toBeTruthy();
    expect(screen.getByText("St Stephen Parish")).toBeTruthy();
    expect(screen.getByText("Godparents present")).toBeTruthy();
    expect(screen.getByText("First Communion")).toBeTruthy();
    expect(screen.getByText("2018-05-20")).toBeTruthy();

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("retry state on a failed load displays 'Failed to load life events' with retry button", async () => {
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        attempts += 1;
        if (attempts === 1) {
          return new Response(null, { status: 500 });
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                eventId: "00000000-0000-4000-8000-000000000001",
                version: 1,
                type: "baptism",
                date: "2010-04-15",
                place: null,
                notes: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();

    expect(await screen.findByText("Failed to load life events")).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeTruthy();

    fireEvent.click(retryBtn);

    expect(await screen.findByText("Baptism")).toBeTruthy();
    expect(attempts).toBe(2);

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);
  });

  it("add form submits type, date, place, notes and updates list", async () => {
    let currentEvents: LifeEvent[] = [];
    const calls: { path: string; body: unknown }[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (url.includes("/v1/people/life-events/list")) {
        calls.push({ path: "list", body });
        return new Response(JSON.stringify({ items: currentEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/people/life-events/create")) {
        calls.push({ path: "create", body });
        const b = body as {
          type: LifeEventType;
          date: string;
          place?: string;
          notes?: string;
        };
        currentEvents = [
          {
            eventId: "00000000-0000-4000-8000-000000000099",
            version: 1,
            type: b.type,
            date: b.date,
            place: b.place ?? null,
            notes: b.notes ?? null,
          },
        ];
        return new Response(
          JSON.stringify({
            eventId: "00000000-0000-4000-8000-000000000099",
            version: 1,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();
    expect(await screen.findByText("No life events recorded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add life event/i }));

    const typeSelect = screen.getByLabelText(/Event type/i);
    const dateInput = screen.getByLabelText(/Date/i);
    const placeInput = screen.getByLabelText(/Place/i);
    const notesInput = screen.getByLabelText(/Notes/i);

    fireEvent.change(typeSelect, { target: { value: "marriage" } });
    fireEvent.change(dateInput, { target: { value: "2015-08-20" } });
    fireEvent.change(placeInput, { target: { value: "St Mary Cathedral" } });
    fireEvent.change(notesInput, { target: { value: "Witnesses signed" } });

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save life event" }));

    expect(await screen.findByText("2015-08-20")).toBeTruthy();
    expect(screen.getByText("Marriage")).toBeTruthy();
    expect(screen.getByText("St Mary Cathedral")).toBeTruthy();
    expect(screen.getByText("Witnesses signed")).toBeTruthy();

    const createCall = calls.find((c) => c.path === "create");
    expect(createCall?.body).toEqual({
      communitySlug: SLUG,
      personId: PERSON_ID,
      type: "marriage",
      date: "2015-08-20",
      place: "St Mary Cathedral",
      notes: "Witnesses signed",
    });
  });

  it("edit form submits with version and updates list", async () => {
    let currentEvents: LifeEvent[] = [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        version: 1,
        type: "baptism",
        date: "2010-04-15",
        place: "Old Church",
        notes: "Old notes",
      },
    ];
    const calls: { path: string; body: unknown }[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: currentEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/people/life-events/update")) {
        calls.push({ path: "update", body });
        const b = body as {
          eventId: string;
          version: number;
          type: LifeEventType;
          date: string;
          place?: string;
          notes?: string;
        };
        currentEvents = [
          {
            eventId: b.eventId,
            version: b.version + 1,
            type: b.type,
            date: b.date,
            place: b.place ?? null,
            notes: b.notes ?? null,
          },
        ];
        return new Response(JSON.stringify({ version: b.version + 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();
    expect(await screen.findByText("Baptism")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    const placeInput = screen.getByLabelText(/Place/i);
    fireEvent.change(placeInput, { target: { value: "Corrected Church" } });

    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(resultIds(results, "violations")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Corrected Church")).toBeTruthy();

    const updateCall = calls.find((c) => c.path === "update");
    expect(updateCall?.body).toEqual({
      communitySlug: SLUG,
      eventId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      type: "baptism",
      date: "2010-04-15",
      place: "Corrected Church",
      notes: "Old notes",
    });
  });

  it("409 conflict on update shows refresh prompt", async () => {
    let listCount = 0;
    const initialEvent: LifeEvent = {
      eventId: "00000000-0000-4000-8000-000000000001",
      version: 1,
      type: "baptism",
      date: "2010-04-15",
      place: "Old Church",
      notes: null,
    };
    const refreshedEvent: LifeEvent = {
      ...initialEvent,
      version: 2,
      place: "Church updated by another user",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        listCount += 1;
        return new Response(
          JSON.stringify({ items: [listCount === 1 ? initialEvent : refreshedEvent] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/people/life-events/update")) {
        return new Response(null, { status: 409 });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel();
    expect(await screen.findByText("Baptism")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/This record was modified by someone else|modified by another user/i),
    ).toBeTruthy();
    const refreshBtn = screen.getByRole("button", { name: "Refresh" });
    expect(refreshBtn).toBeTruthy();

    fireEvent.click(refreshBtn);

    expect(await screen.findByText("Church updated by another user")).toBeTruthy();
    expect(listCount).toBe(2);
  });

  const DATE_HINT = "Check the date: it cannot be in the future or before 1900.";
  const GENERIC = "Failed to save life event";
  const existingEvent: LifeEvent = {
    eventId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    type: "baptism",
    date: "2010-04-15",
    place: "Old Church",
    notes: null,
  };

  function mockSave(route: "create" | "update", saveStatus: number | "network") {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: route === "update" ? [existingEvent] : [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes(`/v1/people/life-events/${route}`)) {
        if (saveStatus === "network") throw new TypeError("network down");
        return new Response(null, { status: saveStatus });
      }
      return new Response(null, { status: 404 });
    });
  }

  async function submit(route: "create" | "update") {
    renderPanel();
    if (route === "create") {
      expect(await screen.findByText("No life events recorded")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Add life event/i }));
      fireEvent.change(screen.getByLabelText(/Event type/i), { target: { value: "baptism" } });
      fireEvent.change(screen.getByLabelText(/Date/i), { target: { value: "2020-01-01" } });
      fireEvent.click(screen.getByRole("button", { name: "Save life event" }));
    } else {
      expect(await screen.findByText("Baptism")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Edit/i }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    }
  }

  for (const route of ["create", "update"] as const) {
    it(`400 on ${route} keeps the form open and explains the date`, async () => {
      mockSave(route, 400);
      await submit(route);
      expect(await screen.findByText(DATE_HINT)).toBeTruthy();
      expect(screen.queryByText(GENERIC)).toBeNull();
      expect(
        screen.getByRole("button", {
          name: route === "create" ? "Save life event" : "Save changes",
        }),
      ).toBeTruthy();
    });

    for (const failure of [500, "network"] as const) {
      it(`${failure} on ${route} still shows the generic message`, async () => {
        mockSave(route, failure);
        await submit(route);
        expect(await screen.findByText(GENERIC)).toBeTruthy();
        expect(screen.queryByText(DATE_HINT)).toBeNull();
      });
    }
  }

  it("a failing request displays no event content in the DOM text of an error", async () => {
    const sensitivePlace = "SecretChapelLocation123";
    const sensitiveNotes = "ConfidentialNotesText456";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v1/people/life-events/create")) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel();
    expect(await screen.findByText("No life events recorded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add life event/i }));

    fireEvent.change(screen.getByLabelText(/Event type/i), { target: { value: "baptism" } });
    fireEvent.change(screen.getByLabelText(/Date/i), { target: { value: "2020-01-01" } });
    fireEvent.change(screen.getByLabelText(/Place/i), { target: { value: sensitivePlace } });
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: sensitiveNotes } });

    fireEvent.click(screen.getByRole("button", { name: "Save life event" }));

    expect(await screen.findByText("Failed to save life event")).toBeTruthy();

    const errorAlert = screen.getByRole("alert");
    expect(errorAlert.textContent).not.toContain(sensitivePlace);
    expect(errorAlert.textContent).not.toContain(sensitiveNotes);
  });

  it("drops in-flight requests on community switch", async () => {
    let resolveFirstList: (value: Response) => void;
    const firstListPromise = new Promise<Response>((resolve) => {
      resolveFirstList = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info, init) => {
      const url = String(info);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url.includes("/v1/people/life-events/list")) {
        if (body.communitySlug === "comm-one") {
          return firstListPromise;
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                eventId: "00000000-0000-4000-8000-000000000002",
                version: 1,
                type: "funeral",
                date: "2021-03-01",
                place: null,
                notes: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    });

    function Switcher() {
      const { setSlug } = useCommunity();
      return (
        <div>
          <button type="button" onClick={() => setSlug("comm-two")}>
            Switch to comm-two
          </button>
          <LifeEventsPanel
            personId={PERSON_ID}
            personName="Arthur Clarke"
            isReadOnly={false}
            canManage={true}
          />
        </div>
      );
    }

    sessionStorage.setItem("community-hub.community", "comm-one");
    render(
      <CommunityProvider>
        <Switcher />
      </CommunityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to comm-two" }));

    expect(await screen.findByText("Funeral")).toBeTruthy();

    await act(async () => {
      resolveFirstList(
        new Response(
          JSON.stringify({
            items: [
              {
                eventId: "00000000-0000-4000-8000-000000000001",
                version: 1,
                type: "baptism",
                date: "2010-01-01",
                place: null,
                notes: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText("Baptism")).toBeNull();
    expect(screen.getByText("Funeral")).toBeTruthy();
  });

  it("select lists nine event types with Title Case labels in exact order", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel({ canManage: true, isReadOnly: false });

    expect(await screen.findByText("No life events recorded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add life event" }));

    const select = screen.getByLabelText(/Event type/i) as HTMLSelectElement;
    expect(select).toBeTruthy();

    const expected = [
      { value: "baptism", label: "Baptism" },
      { value: "first_communion", label: "First Communion" },
      { value: "marriage", label: "Marriage" },
      { value: "funeral", label: "Funeral" },
      { value: "birth", label: "Birth" },
      { value: "death", label: "Death" },
      { value: "graduation", label: "Graduation" },
      { value: "anniversary", label: "Anniversary" },
      { value: "other", label: "Other" },
    ];

    const options = Array.from(select.options);
    expect(options).toHaveLength(9);
    expect(
      options.map((opt) => ({
        value: opt.value,
        label: opt.textContent?.trim(),
      })),
    ).toEqual(expected);
  });

  it("Pin 22: canManage and isReadOnly independently control Add life event and Edit buttons", async () => {
    const sampleEvents: LifeEvent[] = [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        version: 1,
        type: "baptism",
        date: "2010-04-15",
        place: "St Timothy Chapel",
        notes: "Recorded by parish registrar",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: sampleEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    // 1. canManage: true, isReadOnly: false -> shows Add life event and Edit button
    const { unmount: unmount1 } = renderPanel({ canManage: true, isReadOnly: false });
    expect(await screen.findByText("Baptism")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add life event" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit/i })).toBeTruthy();
    unmount1();
    cleanup();

    // 2. canManage: false, isReadOnly: false -> shows neither
    const { unmount: unmount2 } = renderPanel({ canManage: false, isReadOnly: false });
    expect(await screen.findByText("Baptism")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add life event" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/i })).toBeNull();
    unmount2();
    cleanup();

    // 3. canManage: true, isReadOnly: true -> shows neither
    renderPanel({ canManage: true, isReadOnly: true });
    expect(await screen.findByText("Baptism")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add life event" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/i })).toBeNull();
  });

  it("shows 'None' in muted-foreground for null place and null notes, and no dash", async () => {
    const sampleEvents: LifeEvent[] = [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        version: 1,
        type: "baptism",
        date: "2010-04-15",
        place: null,
        notes: null,
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: sampleEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel();
    expect(await screen.findByText("Baptism")).toBeTruthy();

    const noneElements = screen.getAllByText("None");
    expect(noneElements).toHaveLength(2);
    for (const el of noneElements) {
      expect(el.className).toContain("text-muted-foreground");
    }
    expect(screen.queryByText("-")).toBeNull();
  });

  it("renders h4 panel heading with person name and h5 add form heading", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel({ personName: "Rowan Vance", canManage: true, isReadOnly: false });
    expect(await screen.findByText("No life events recorded")).toBeTruthy();

    const panelHeading = screen.getByRole("heading", {
      level: 4,
      name: "Life events: Rowan Vance",
    });
    expect(panelHeading).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add life event" }));

    const formHeading = screen.getByRole("heading", { level: 5, name: "Add Life Event" });
    expect(formHeading).toBeTruthy();
  });

  it("renders aria-hidden skeleton and sr-only plain span loading words while pending", async () => {
    let resolveList!: (value: Response) => void;
    const listPromise = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return listPromise;
      }
      return new Response(null, { status: 404 });
    });

    const { container } = renderPanel();

    const skeleton = container.querySelector('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");

    const loadingSpan = screen.getByText("Loading life events...");
    expect(loadingSpan.tagName).toBe("SPAN");
    expect(loadingSpan.className).toContain("sr-only");
    expect(loadingSpan.getAttribute("role")).toBeNull();
    expect(loadingSpan.getAttribute("aria-live")).toBeNull();

    await act(async () => {
      resolveList(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    expect(await screen.findByText("No life events recorded")).toBeTruthy();
  });

  it("renders Select and Textarea with data-slot and stable control ids in the add form", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel({ personId: PERSON_ID, canManage: true, isReadOnly: false });
    expect(await screen.findByText("No life events recorded")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add life event" }));

    const typeSelect = screen.getByLabelText(/Event type/i);
    expect(typeSelect.tagName).toBe("SELECT");
    expect(typeSelect.getAttribute("data-slot")).toBe("select");
    expect(typeSelect.id).toBe(`life-event-type-${PERSON_ID}`);

    const notesTextarea = screen.getByLabelText(/Notes/i);
    expect(notesTextarea.tagName).toBe("TEXTAREA");
    expect(notesTextarea.getAttribute("data-slot")).toBe("textarea");
    expect(notesTextarea.id).toBe(`life-event-notes-${PERSON_ID}`);

    const dateInput = screen.getByLabelText(/Date/i);
    expect(dateInput.id).toBe(`life-event-date-${PERSON_ID}`);

    const placeInput = screen.getByLabelText(/Place/i);
    expect(placeInput.id).toBe(`life-event-place-${PERSON_ID}`);
  });

  it("assigns each cell a data-label from column headers with no sensitive or row values", async () => {
    const sampleEvents: LifeEvent[] = [
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        version: 1,
        type: "baptism",
        date: "2010-04-15",
        place: "St Timothy Chapel",
        notes: "Recorded by parish registrar",
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (info) => {
      const url = String(info);
      if (url.includes("/v1/people/life-events/list")) {
        return new Response(JSON.stringify({ items: sampleEvents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderPanel({ personName: "Rowan Vance", canManage: true, isReadOnly: false });
    expect(await screen.findByText("Baptism")).toBeTruthy();

    const cells = screen.getAllByRole("cell");
    expect(cells.length).toBeGreaterThan(0);

    const allowedHeaders = ["Type", "Date", "Place", "Notes", "Actions"];
    for (const cell of cells) {
      const label = cell.getAttribute("data-label");
      expect(allowedHeaders).toContain(label);
      expect(label).not.toBe("Rowan Vance");
      expect(label).not.toBe("St Timothy Chapel");
      expect(label).not.toBe("Recorded by parish registrar");
    }
  });
});
