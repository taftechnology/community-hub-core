import { fireEvent, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  DIRECTORY_COLUMN_COMMUNITIES,
  DIRECTORY_COLUMN_KIND,
  DIRECTORY_COLUMN_ORGANISATION,
  DIRECTORY_COLUMN_REGION,
  DIRECTORY_EMPTY_MESSAGE,
  DIRECTORY_FORBIDDEN_MESSAGE,
  DIRECTORY_LOAD_ERROR_MESSAGE,
  DIRECTORY_LOADING_MESSAGE,
  DIRECTORY_TABLE_CAPTION,
  DIRECTORY_TRUNCATED_MESSAGE,
  SESSION_ENDED_MESSAGE,
  TRY_AGAIN_BUTTON_LABEL,
} from "./messages.js";
import { renderAt, stubDeps } from "./test-support.js";

const signedInMe = {
  status: 200,
  body: { roleKeys: ["ops.directory.view"] },
};

const org1Id = "00000000-0000-4000-8000-000000000001";
const comm1Id = "00000000-0000-4000-8000-000000000011";
const comm2Id = "00000000-0000-4000-8000-000000000012";
const org2Id = "00000000-0000-4000-8000-000000000002";

const sampleDirectory = {
  organisations: [
    {
      id: org1Id,
      slug: "org-alpha",
      kind: "parish",
      region: "ap-southeast-2",
      communities: [
        { id: comm1Id, slug: "community-one" },
        { id: comm2Id, slug: "community-two" },
      ],
    },
    {
      id: org2Id,
      slug: "org-beta",
      kind: "diocese",
      region: "ap-southeast-2",
      communities: [],
    },
  ],
  truncated: false,
};

describe("Directory screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("renders two organisations with communities in server order and no id in DOM", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 200, body: sampleDirectory },
    });

    renderAt("#/", deps);

    await screen.findByRole("heading", { level: 1, name: "Directory" });
    const table = await screen.findByRole("table");
    expect(table).not.toBeNull();
    expect(within(table).getByText(DIRECTORY_TABLE_CAPTION)).not.toBeNull();
    expect(
      within(table).getByRole("columnheader", { name: DIRECTORY_COLUMN_ORGANISATION }),
    ).not.toBeNull();
    expect(within(table).getByRole("columnheader", { name: DIRECTORY_COLUMN_KIND })).not.toBeNull();
    expect(
      within(table).getByRole("columnheader", { name: DIRECTORY_COLUMN_REGION }),
    ).not.toBeNull();
    expect(
      within(table).getByRole("columnheader", { name: DIRECTORY_COLUMN_COMMUNITIES }),
    ).not.toBeNull();

    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);

    // Row 1: org-alpha
    expect(within(rows[1]!).getByText("org-alpha")).not.toBeNull();
    expect(within(rows[1]!).getByText("parish")).not.toBeNull();
    expect(within(rows[1]!).getByText("ap-southeast-2")).not.toBeNull();
    const commListItems = within(rows[1]!).getAllByRole("listitem");
    expect(commListItems).toHaveLength(2);
    expect(commListItems[0]!.textContent).toBe("community-one");
    expect(commListItems[1]!.textContent).toBe("community-two");

    // Row 2: org-beta
    expect(within(rows[2]!).getByText("org-beta")).not.toBeNull();
    expect(within(rows[2]!).getByText("diocese")).not.toBeNull();
    expect(within(rows[2]!).getByText("ap-southeast-2")).not.toBeNull();
    expect(within(rows[2]!).queryAllByRole("listitem")).toHaveLength(0);

    // No id string appears in the DOM
    expect(document.body.innerHTML).not.toContain(org1Id);
    expect(document.body.innerHTML).not.toContain(org2Id);
    expect(document.body.innerHTML).not.toContain(comm1Id);
    expect(document.body.innerHTML).not.toContain(comm2Id);
  });

  it("truncated: true shows the notice", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": {
        status: 200,
        body: {
          ...sampleDirectory,
          truncated: true,
        },
      },
    });

    renderAt("#/", deps);

    await screen.findByRole("table");
    expect(screen.getByText(DIRECTORY_TRUNCATED_MESSAGE)).not.toBeNull();
  });

  it("an empty list shows the empty text", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": {
        status: 200,
        body: {
          organisations: [],
          truncated: false,
        },
      },
    });

    renderAt("#/", deps);

    await screen.findByRole("heading", { level: 1, name: "Directory" });
    expect(await screen.findByText(DIRECTORY_EMPTY_MESSAGE)).not.toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a 403 shows the role text", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 403 },
    });

    renderAt("#/", deps);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(DIRECTORY_FORBIDDEN_MESSAGE);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a 500 shows the failure text, and Try again refetches", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": [{ status: 500 }, { status: 200, body: sampleDirectory }],
    });

    renderAt("#/", deps);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(DIRECTORY_LOAD_ERROR_MESSAGE);
    const retryBtn = screen.getByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });

    fireEvent.click(retryBtn);

    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an invalid body shows the could-not-load text and Try again", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 200, body: { invalid: true } },
    });

    renderAt("#/", deps);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(DIRECTORY_LOAD_ERROR_MESSAGE);
    expect(screen.getByRole("button", { name: TRY_AGAIN_BUTTON_LABEL })).not.toBeNull();
  });

  it("session ended: me 200, then directory 401, repeat 401, refresh 401 ends on Sign in with the session-ended alert", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 401 },
      "POST /v1/ops/session/refresh": { status: 401 },
    });

    renderAt("#/", deps);

    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SESSION_ENDED_MESSAGE);
  });

  it("one rotation: directory 401, repeat 401, refresh 200, repeat 200 shows the table after exactly one refresh", async () => {
    const deps = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": [
        { status: 401 },
        { status: 401 },
        { status: 200, body: sampleDirectory },
      ],
      "POST /v1/ops/session/refresh": { status: 200 },
    });

    renderAt("#/", deps);

    await screen.findByRole("table");
    const refreshCalls = deps.calls.filter((c) => c.path === "/v1/ops/session/refresh");
    expect(refreshCalls).toHaveLength(1);
  });

  it("axe: passes on loading, list, empty, truncated, 403 and failed states", async () => {
    // 1. Loading state
    let resolveDir!: (val: unknown) => void;
    const pendingDir = new Promise((res) => {
      resolveDir = res;
    });
    const depsLoading = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": () => pendingDir as unknown as Response,
    });
    const { container: containerLoading, unmount: unmountLoading } = renderAt("#/", depsLoading);
    await screen.findByRole("status");
    expect(screen.getByRole("status").textContent).toBe(DIRECTORY_LOADING_MESSAGE);
    let results = await axe.run(containerLoading, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountLoading();
    resolveDir(new Response(JSON.stringify(sampleDirectory), { status: 200 }));

    // 2. List state
    const depsList = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 200, body: sampleDirectory },
    });
    const { container: containerList, unmount: unmountList } = renderAt("#/", depsList);
    await screen.findByRole("table");
    results = await axe.run(containerList, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountList();

    // 3. Empty state
    const depsEmpty = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 200, body: { organisations: [], truncated: false } },
    });
    const { container: containerEmpty, unmount: unmountEmpty } = renderAt("#/", depsEmpty);
    await screen.findByText(DIRECTORY_EMPTY_MESSAGE);
    results = await axe.run(containerEmpty, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountEmpty();

    // 4. Truncated state
    const depsTruncated = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 200, body: { ...sampleDirectory, truncated: true } },
    });
    const { container: containerTruncated, unmount: unmountTruncated } = renderAt(
      "#/",
      depsTruncated,
    );
    await screen.findByText(DIRECTORY_TRUNCATED_MESSAGE);
    results = await axe.run(containerTruncated, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountTruncated();

    // 5. 403 state
    const deps403 = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 403 },
    });
    const { container: container403, unmount: unmount403 } = renderAt("#/", deps403);
    await screen.findByRole("alert");
    results = await axe.run(container403, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmount403();

    // 6. Failed state
    const depsFailed = stubDeps({
      "GET /v1/ops/me": signedInMe,
      "GET /v1/ops/directory": { status: 500 },
    });
    const { container: containerFailed, unmount: unmountFailed } = renderAt("#/", depsFailed);
    await screen.findByRole("button", { name: TRY_AGAIN_BUTTON_LABEL });
    results = await axe.run(containerFailed, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
    unmountFailed();
  });
});
