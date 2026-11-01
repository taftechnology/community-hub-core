import {
  Alert,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@community-hub/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { usePeopleAccess } from "./people-access";

type HouseholdItem = {
  householdId: string;
  version: number;
  label: string | null;
  adultCount: number;
};

type ListResponse = {
  items: HouseholdItem[];
  nextCursor: string | null;
};

type AdultMember = {
  personId: string;
  givenName: string;
  familyName: string;
  version: number;
};

type MinorMember = {
  personId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string | null;
  version: number;
};

type GuardianRights = {
  consent: boolean;
  pickup: boolean;
  view: boolean;
  manage: boolean;
};

type GuardianLink = {
  linkId: string;
  guardianId: string;
  childId: string;
  rights: GuardianRights;
};

type HouseholdDetail = {
  householdId: string;
  version: number;
  label: string | null;
  adults: AdultMember[];
  minors?: MinorMember[] | undefined;
  guardians: GuardianLink[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHouseholdItem(item: unknown): HouseholdItem | null {
  if (!isRecord(item) || typeof item.householdId !== "string" || typeof item.version !== "number") {
    return null;
  }
  return {
    householdId: item.householdId,
    version: item.version,
    label: typeof item.label === "string" ? item.label : null,
    adultCount: typeof item.adultCount === "number" ? item.adultCount : 0,
  };
}

function parseListResponse(value: unknown): ListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: HouseholdItem[] = [];
  for (const item of value.items) {
    const parsed = parseHouseholdItem(item);
    if (parsed !== null) {
      items.push(parsed);
    }
  }
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
  return { items, nextCursor };
}

function parseAdultMember(value: unknown): AdultMember | null {
  if (!isRecord(value) || typeof value.personId !== "string") {
    return null;
  }
  return {
    personId: value.personId,
    givenName: typeof value.givenName === "string" ? value.givenName : "",
    familyName: typeof value.familyName === "string" ? value.familyName : "",
    version: typeof value.version === "number" ? value.version : 1,
  };
}

function parseMinorMember(value: unknown): MinorMember | null {
  if (!isRecord(value) || typeof value.personId !== "string") {
    return null;
  }
  return {
    personId: value.personId,
    givenName: typeof value.givenName === "string" ? value.givenName : "",
    familyName: typeof value.familyName === "string" ? value.familyName : "",
    dateOfBirth: typeof value.dateOfBirth === "string" ? value.dateOfBirth : null,
    version: typeof value.version === "number" ? value.version : 1,
  };
}

function parseGuardianLink(value: unknown): GuardianLink | null {
  if (
    !isRecord(value) ||
    typeof value.linkId !== "string" ||
    typeof value.guardianId !== "string" ||
    typeof value.childId !== "string"
  ) {
    return null;
  }
  const rightsRecord = isRecord(value.rights) ? value.rights : {};
  return {
    linkId: value.linkId,
    guardianId: value.guardianId,
    childId: value.childId,
    rights: {
      consent: Boolean(rightsRecord.consent),
      pickup: Boolean(rightsRecord.pickup),
      view: Boolean(rightsRecord.view),
      manage: Boolean(rightsRecord.manage),
    },
  };
}

function parseHouseholdDetail(value: unknown): HouseholdDetail | null {
  if (
    !isRecord(value) ||
    typeof value.householdId !== "string" ||
    typeof value.version !== "number"
  ) {
    return null;
  }
  const adults: AdultMember[] = [];
  if (Array.isArray(value.adults)) {
    for (const a of value.adults) {
      const parsed = parseAdultMember(a);
      if (parsed) {
        adults.push(parsed);
      }
    }
  }
  let minors: MinorMember[] | undefined = undefined;
  if (Array.isArray(value.minors)) {
    minors = [];
    for (const m of value.minors) {
      const parsed = parseMinorMember(m);
      if (parsed) {
        minors.push(parsed);
      }
    }
  }
  const guardians: GuardianLink[] = [];
  if (Array.isArray(value.guardians)) {
    for (const g of value.guardians) {
      const parsed = parseGuardianLink(g);
      if (parsed) {
        guardians.push(parsed);
      }
    }
  }
  const detail: HouseholdDetail = {
    householdId: value.householdId,
    version: value.version,
    label: typeof value.label === "string" ? value.label : null,
    adults,
    guardians,
  };
  if (minors !== undefined) {
    detail.minors = minors;
  }
  return detail;
}

export function FamilyRecordsPage() {
  const token = readAccessToken();
  const { slug, version } = useCommunity();
  const { access } = usePeopleAccess();

  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedHouseholdId, setSelectedHouseholdId] = useState<string | null>(null);

  const [items, setItems] = useState<HouseholdItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [detailHousehold, setDetailHousehold] = useState<HouseholdDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const [detailError, setDetailError] = useState(false);

  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view === "list") {
      listHeadingRef.current?.focus();
    } else if (view === "detail") {
      detailHeadingRef.current?.focus();
    }
  }, [view]);

  const generation = useRef(0);
  const detailGeneration = useRef(0);

  const fetchHouseholds = useCallback(
    async (communitySlug: string, cursorToken: string | undefined, isCurrent: () => boolean) => {
      setLoading(true);
      setError(false);

      const body: Record<string, unknown> = {
        communitySlug,
        limit: 25,
      };
      if (cursorToken !== undefined) {
        body.cursor = cursorToken;
      }

      const response = await post("/v1/households/list", body);
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable" || response.status !== 200) {
        setLoading(false);
        setError(true);
        return;
      }
      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parseListResponse(data);
        if (parsed === null) {
          setLoading(false);
          setError(true);
          return;
        }
        setItems(parsed.items);
        setNextCursor(parsed.nextCursor);
        setLoading(false);
        setError(false);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setLoading(false);
        setError(true);
      }
    },
    [],
  );

  const fetchDetail = useCallback(
    async (communitySlug: string, householdId: string, isCurrent: () => boolean) => {
      setDetailLoading(true);
      setDetailNotFound(false);
      setDetailError(false);

      const response = await post("/v1/households/read", {
        communitySlug,
        householdId,
      });
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable") {
        setDetailLoading(false);
        setDetailError(true);
        return;
      }
      if (response.status === 404) {
        setDetailLoading(false);
        setDetailNotFound(true);
        return;
      }
      if (response.status !== 200) {
        setDetailLoading(false);
        setDetailError(true);
        return;
      }
      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parseHouseholdDetail(data);
        if (parsed === null) {
          setDetailLoading(false);
          setDetailError(true);
          return;
        }
        setDetailHousehold(parsed);
        setDetailLoading(false);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setDetailLoading(false);
        setDetailError(true);
      }
    },
    [],
  );

  useEffect(() => {
    setItems(null);
    setView("list");
    setSelectedHouseholdId(null);
    setDetailHousehold(null);
    setCursor(undefined);
  }, [slug]);

  useEffect(() => {
    if (!token) {
      return;
    }
    if (!access.entitlements["people.households"] || !access.permissions["people.view"]) {
      return;
    }
    if (!slug) {
      setItems(null);
      setNextCursor(null);
      return;
    }
    const mine = ++generation.current;
    void fetchHouseholds(slug, cursor, () => generation.current === mine);
  }, [token, access, slug, version, cursor, fetchHouseholds]);

  function openDetail(householdId: string) {
    setSelectedHouseholdId(householdId);
    setView("detail");
    setDetailHousehold(null);
    const mine = ++detailGeneration.current;
    if (slug) {
      void fetchDetail(slug, householdId, () => detailGeneration.current === mine);
    }
  }

  function reloadDetail() {
    if (slug && selectedHouseholdId) {
      const mine = ++detailGeneration.current;
      void fetchDetail(slug, selectedHouseholdId, () => detailGeneration.current === mine);
    }
  }

  function backToList() {
    setView("list");
    setSelectedHouseholdId(null);
    setDetailHousehold(null);
    setDetailNotFound(false);
    setDetailError(false);
  }

  function reloadList() {
    if (slug) {
      const mine = ++generation.current;
      void fetchHouseholds(slug, cursor, () => generation.current === mine);
    }
  }

  function handleNextPage(token: string) {
    setCursor(token);
  }

  if (!token) {
    return (
      <>
        <h1>Family Records</h1>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (!access.entitlements["people.households"] || !access.permissions["people.view"]) {
    return (
      <>
        <h1>Family Records</h1>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  if (view === "detail") {
    return (
      <>
        <h1>Family Records</h1>
        <h2 ref={detailHeadingRef} tabIndex={-1}>
          Household Details
        </h2>

        <Button type="button" onClick={backToList}>
          Back to list
        </Button>

        {detailLoading ? <p>Loading household details...</p> : null}

        {detailNotFound ? (
          <Alert live="polite">
            <span>Household not found</span>
          </Alert>
        ) : null}

        {detailError ? (
          <Alert variant="destructive" live="assertive">
            <span>Failed to load household</span>
            <Button type="button" onClick={reloadDetail}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {!detailLoading && !detailNotFound && !detailError && detailHousehold ? (
          <div>
            {detailHousehold.label ? (
              <p>
                <strong>Household name:</strong> {detailHousehold.label}
              </p>
            ) : null}

            <h3>Adults</h3>
            {detailHousehold.adults.length === 0 ? (
              <p>No adult members</p>
            ) : (
              <Table aria-label="Adult members">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Given name</TableHead>
                    <TableHead scope="col">Family name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailHousehold.adults.map((adult) => (
                    <TableRow key={adult.personId}>
                      <TableCell>{adult.givenName}</TableCell>
                      <TableCell>{adult.familyName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {access.permissions["people.restricted.read"] && detailHousehold.minors ? (
              <>
                <h3>Minors</h3>
                {detailHousehold.minors.length === 0 ? (
                  <p>No minor members</p>
                ) : (
                  <Table aria-label="Minor members">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Given name</TableHead>
                        <TableHead scope="col">Family name</TableHead>
                        <TableHead scope="col">Date of birth</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailHousehold.minors.map((minor) => (
                        <TableRow key={minor.personId}>
                          <TableCell>{minor.givenName}</TableCell>
                          <TableCell>{minor.familyName}</TableCell>
                          <TableCell>{minor.dateOfBirth ?? "None"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                <h3>Guardians</h3>
                {detailHousehold.guardians.length === 0 ? (
                  <p>No guardian links</p>
                ) : (
                  <Table aria-label="Guardian links">
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">Guardian</TableHead>
                        <TableHead scope="col">Child</TableHead>
                        <TableHead scope="col">Rights</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailHousehold.guardians.map((link) => {
                        const guardian = detailHousehold.adults.find(
                          (a) => a.personId === link.guardianId,
                        );
                        const minor = detailHousehold.minors?.find(
                          (m) => m.personId === link.childId,
                        );
                        const guardianName = guardian
                          ? `${guardian.givenName} ${guardian.familyName}`
                          : link.guardianId;
                        const childName = minor
                          ? `${minor.givenName} ${minor.familyName}`
                          : link.childId;
                        const rightsList = [
                          link.rights.consent && "Consent",
                          link.rights.pickup && "Pickup",
                          link.rights.view && "View",
                          link.rights.manage && "Manage",
                        ]
                          .filter(Boolean)
                          .join(", ");
                        return (
                          <TableRow key={link.linkId}>
                            <TableCell>{guardianName}</TableCell>
                            <TableCell>{childName}</TableCell>
                            <TableCell>{rightsList || "None"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <h1 ref={listHeadingRef} tabIndex={-1}>
        Family Records
      </h1>

      {loading && items === null ? <p>Loading households...</p> : null}

      {error ? (
        <Alert variant="destructive" live="assertive">
          <span>Failed to load households</span>
          <Button type="button" onClick={reloadList}>
            Retry
          </Button>
        </Alert>
      ) : null}

      {!error && items !== null ? (
        <>
          {items.length === 0 ? (
            <p>No households yet</p>
          ) : (
            <>
              <Table aria-label="Households">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Household</TableHead>
                    <TableHead scope="col">Adults</TableHead>
                    <TableHead scope="col">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((household) => (
                    <TableRow key={household.householdId}>
                      <TableCell>{household.label ?? "—"}</TableCell>
                      <TableCell>{household.adultCount}</TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`View ${household.label ?? "household"}`}
                          onClick={() => openDetail(household.householdId)}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {nextCursor !== null ? (
                <Button type="button" onClick={() => handleNextPage(nextCursor)}>
                  Next page
                </Button>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </>
  );
}
