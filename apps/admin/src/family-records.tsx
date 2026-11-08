import {
  Alert,
  Avatar,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Input,
  Pagination,
  Panel,
  RestrictedValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { LifeEventsPanel } from "./life-events";
import { type PeopleAccess, usePeopleAccess } from "./people-access";
import { ScreenTitle } from "./screen-title";

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

export type HouseholdDetail = {
  householdId: string;
  version: number;
  label: string | null;
  adults: AdultMember[];
  minors?: MinorMember[] | undefined;
  guardians: GuardianLink[];
};

type ViewMode =
  | "list"
  | "detail"
  | "create"
  | "rename"
  | "move-adult"
  | "add-adult"
  | "add-minor"
  | "link-guardian";

type AdultSearchItem = {
  personId: string;
  givenName: string;
  familyName: string;
  version: number;
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

function parseAdultSearchItem(item: unknown): AdultSearchItem | null {
  if (!isRecord(item) || typeof item.version !== "number") {
    return null;
  }
  const personId =
    typeof item.personId === "string"
      ? item.personId
      : typeof item.id === "string"
        ? item.id
        : null;
  if (personId === null) {
    return null;
  }
  return {
    personId,
    givenName: typeof item.givenName === "string" ? item.givenName : "",
    familyName: typeof item.familyName === "string" ? item.familyName : "",
    version: item.version,
  };
}

function parseAdultSearchResponse(
  value: unknown,
): { items: AdultSearchItem[]; nextCursor: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: AdultSearchItem[] = [];
  for (const item of value.items) {
    const parsed = parseAdultSearchItem(item);
    if (parsed !== null) {
      items.push(parsed);
    }
  }
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
  return { items, nextCursor };
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

const initialRights: GuardianRights = {
  consent: true,
  pickup: false,
  view: true,
  manage: false,
};

export type MinorsSectionProps = {
  detailHousehold: HouseholdDetail;
  access: PeopleAccess;
  isReadOnly: boolean;
  canManage?: boolean;
  unlinkingLinkId?: string | null;
  submitting?: boolean;
  openAddMinor?: () => void;
  openLinkGuardian?: () => void;
  handleConfirmUnlink?: (linkId: string) => void;
  setUnlinkingLinkId?: (id: string | null) => void;
  setUnlinkNotice?: (notice: string | null) => void;
};

function getGuardianLinkDetails(link: GuardianLink, household: HouseholdDetail) {
  const guardian = household.adults.find((a) => a.personId === link.guardianId);
  const minor = household.minors?.find((m) => m.personId === link.childId);
  const guardianName = guardian ? `${guardian.givenName} ${guardian.familyName}` : link.guardianId;
  const childName = minor ? `${minor.givenName} ${minor.familyName}` : link.childId;
  const rightsList = [
    link.rights.consent && "Consent",
    link.rights.pickup && "Pickup",
    link.rights.view && "View",
    link.rights.manage && "Manage",
  ]
    .filter(Boolean)
    .join(", ");
  return { guardianName, childName, rightsList };
}

export function MinorsSection({
  detailHousehold,
  access,
  isReadOnly,
  canManage: canManageProp,
  unlinkingLinkId = null,
  submitting = false,
  openAddMinor,
  openLinkGuardian,
  handleConfirmUnlink,
  setUnlinkingLinkId,
  setUnlinkNotice,
}: MinorsSectionProps) {
  const canManage = canManageProp ?? Boolean(access.permissions["people.manage"]);
  const canRestricted = Boolean(access.permissions["people.restricted.read"]);
  const canReadLifeEvents = canRestricted && Boolean(access.entitlements["people.households"]);
  const canAddMinor = canManage && canRestricted && !isReadOnly;
  const canLinkGuardian = canManage && canRestricted && !isReadOnly;
  const canUnlinkGuardian = canManage && canRestricted && !isReadOnly;

  const minorColumns: DataTableColumn<MinorMember>[] = [
    {
      key: "givenName",
      header: "Given name",
      primary: true,
      render: (minor) => minor.givenName,
    },
    {
      key: "familyName",
      header: "Family name",
      render: (minor) => minor.familyName,
    },
    {
      key: "dateOfBirth",
      header: "Date of birth",
      render: (minor) =>
        minor.dateOfBirth ? minor.dateOfBirth : <span className="text-muted-foreground">None</span>,
    },
  ];

  const guardianColumns: DataTableColumn<GuardianLink>[] = [
    {
      key: "guardian",
      header: "Guardian",
      render: (link) => getGuardianLinkDetails(link, detailHousehold).guardianName,
    },
    {
      key: "child",
      header: "Child",
      render: (link) => getGuardianLinkDetails(link, detailHousehold).childName,
    },
    {
      key: "rights",
      header: "Rights",
      render: (link) =>
        getGuardianLinkDetails(link, detailHousehold).rightsList || (
          <span className="text-muted-foreground">None</span>
        ),
    },
    ...(canUnlinkGuardian
      ? [
          {
            key: "actions",
            header: "Actions",
            render: (link: GuardianLink) => {
              const { guardianName, childName } = getGuardianLinkDetails(link, detailHousehold);
              return unlinkingLinkId === link.linkId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>Are you sure you want to remove this guardian link?</span>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={submitting}
                    onClick={() => handleConfirmUnlink?.(link.linkId)}
                  >
                    Confirm unlink
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => {
                      setUnlinkingLinkId?.(null);
                      setUnlinkNotice?.(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Unlink ${guardianName} from ${childName}`}
                  onClick={() => {
                    setUnlinkingLinkId?.(link.linkId);
                    setUnlinkNotice?.(null);
                  }}
                >
                  Unlink
                </Button>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <Panel
        title="Minors"
        level={3}
        actions={
          canAddMinor ? (
            <Button type="button" onClick={openAddMinor}>
              Add minor
            </Button>
          ) : null
        }
      >
        {detailHousehold.minors && detailHousehold.minors.length === 0 ? (
          <p>No minor members</p>
        ) : (
          <DataTable
            aria-label="Minor members"
            rowKey={(minor) => minor.personId}
            rows={detailHousehold.minors ?? []}
            columns={minorColumns}
          />
        )}

        {canReadLifeEvents && detailHousehold.minors
          ? detailHousehold.minors.map((minor) => (
              <LifeEventsPanel
                key={minor.personId}
                personId={minor.personId}
                personName={`${minor.givenName} ${minor.familyName}`}
                isReadOnly={isReadOnly}
                canManage={canManage}
              />
            ))
          : null}
      </Panel>

      <Panel
        title="Guardians"
        level={3}
        actions={
          canLinkGuardian ? (
            <Button type="button" onClick={openLinkGuardian}>
              Link guardian
            </Button>
          ) : null
        }
      >
        {detailHousehold.guardians.length === 0 ? (
          <p>No guardian links</p>
        ) : (
          <DataTable
            aria-label="Guardian links"
            rowKey={(link) => link.linkId}
            rows={detailHousehold.guardians}
            columns={guardianColumns}
          />
        )}
      </Panel>
    </>
  );
}

export function FamilyRecordsPage() {
  const token = readAccessToken();
  const { slug, version } = useCommunity();
  const { access } = usePeopleAccess();
  const { status, readiness, refresh: refreshBilling } = useBillingStatus();
  const [paymentRequired, setPaymentRequired] = useState(false);

  const [view, setView] = useState<ViewMode>("list");
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

  // Form & Action states
  const [submitting, setSubmitting] = useState(false);

  // Create household
  const [createLabel, setCreateLabel] = useState("");
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  // Rename household
  const [renameLabel, setRenameLabel] = useState("");
  const [renameConflict, setRenameConflict] = useState(false);
  const [renameNotice, setRenameNotice] = useState<string | null>(null);

  // Move adult
  const [selectedAdult, setSelectedAdult] = useState<AdultMember | null>(null);
  const [moveTargetHouseholdId, setMoveTargetHouseholdId] = useState("");
  const [moveConflict, setMoveConflict] = useState(false);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);

  // Add adult
  const [adultSearchDraft, setAdultSearchDraft] = useState("");
  const [adultSearchResults, setAdultSearchResults] = useState<AdultSearchItem[] | null>(null);
  const [adultSearchNextCursor, setAdultSearchNextCursor] = useState<string | null>(null);
  const [adultSearchLoading, setAdultSearchLoading] = useState(false);
  const [adultSearchError, setAdultSearchError] = useState(false);
  const [adultSearchNotice, setAdultSearchNotice] = useState<string | null>(null);
  const adultSearchGeneration = useRef(0);

  // Add minor
  const [minorGivenName, setMinorGivenName] = useState("");
  const [minorFamilyName, setMinorFamilyName] = useState("");
  const [minorDob, setMinorDob] = useState("");
  const [minorGuardianId, setMinorGuardianId] = useState("");
  const [minorRights, setMinorRights] = useState<GuardianRights>(initialRights);
  const [addMinorNotice, setAddMinorNotice] = useState<string | null>(null);

  // Link guardian
  const [linkGuardianId, setLinkGuardianId] = useState("");
  const [linkChildId, setLinkChildId] = useState("");
  const [linkRights, setLinkRights] = useState<GuardianRights>(initialRights);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);

  // Unlink guardian
  const [unlinkingLinkId, setUnlinkingLinkId] = useState<string | null>(null);
  const [unlinkNotice, setUnlinkNotice] = useState<string | null>(null);

  // Ref headings for accessibility focus management
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const createHeadingRef = useRef<HTMLHeadingElement>(null);
  const renameHeadingRef = useRef<HTMLHeadingElement>(null);
  const moveAdultHeadingRef = useRef<HTMLHeadingElement>(null);
  const addAdultHeadingRef = useRef<HTMLHeadingElement>(null);
  const addMinorHeadingRef = useRef<HTMLHeadingElement>(null);
  const linkGuardianHeadingRef = useRef<HTMLHeadingElement>(null);

  // Ref alerts for screen reader focus
  const createAlertRef = useRef<HTMLDivElement>(null);
  const renameAlertRef = useRef<HTMLDivElement>(null);
  const moveAlertRef = useRef<HTMLDivElement>(null);
  const addAdultAlertRef = useRef<HTMLDivElement>(null);
  const addMinorAlertRef = useRef<HTMLDivElement>(null);
  const linkAlertRef = useRef<HTMLDivElement>(null);
  const unlinkAlertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view === "list") {
      listHeadingRef.current?.focus();
    } else if (view === "detail") {
      detailHeadingRef.current?.focus();
    } else if (view === "create") {
      createHeadingRef.current?.focus();
    } else if (view === "rename") {
      renameHeadingRef.current?.focus();
    } else if (view === "move-adult") {
      moveAdultHeadingRef.current?.focus();
    } else if (view === "add-adult") {
      addAdultHeadingRef.current?.focus();
    } else if (view === "add-minor") {
      addMinorHeadingRef.current?.focus();
    } else if (view === "link-guardian") {
      linkGuardianHeadingRef.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (createNotice) {
      createAlertRef.current?.focus();
    }
  }, [createNotice]);

  useEffect(() => {
    if (renameConflict || renameNotice) {
      renameAlertRef.current?.focus();
    }
  }, [renameConflict, renameNotice]);

  useEffect(() => {
    if (moveConflict || moveNotice) {
      moveAlertRef.current?.focus();
    }
  }, [moveConflict, moveNotice]);

  useEffect(() => {
    if (adultSearchNotice) {
      addAdultAlertRef.current?.focus();
    }
  }, [adultSearchNotice]);

  useEffect(() => {
    if (addMinorNotice) {
      addMinorAlertRef.current?.focus();
    }
  }, [addMinorNotice]);

  useEffect(() => {
    if (linkNotice) {
      linkAlertRef.current?.focus();
    }
  }, [linkNotice]);

  useEffect(() => {
    if (unlinkNotice) {
      unlinkAlertRef.current?.focus();
    }
  }, [unlinkNotice]);

  const generation = useRef(0);
  const detailGeneration = useRef(0);

  const isReadOnly = status?.state === "none" || status?.state === "read_only" || paymentRequired;
  const hideWrites = readiness === "loading" || isReadOnly;

  const canManage = Boolean(access.permissions["people.manage"]);
  const canRestricted = Boolean(access.permissions["people.restricted.read"]);
  const canReadLifeEvents = canRestricted && Boolean(access.entitlements["people.households"]);

  const canCreate = canManage && !hideWrites;
  const canRename = canManage && canRestricted && !hideWrites;
  const canMoveAdult = canManage && canRestricted && !hideWrites;
  const canAddAdult = canMoveAdult && Boolean(access.entitlements["people.directory"]);
  const canAddMinor = canManage && canRestricted && !hideWrites;
  const canLinkGuardian = canManage && canRestricted && !hideWrites;
  const canUnlinkGuardian = canManage && canRestricted && !hideWrites;

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
    detailGeneration.current += 1;
    setItems(null);
    setView("list");
    setSelectedHouseholdId(null);
    setDetailHousehold(null);
    setCursor(undefined);
    setCreateLabel("");
    setCreateNotice(null);
    setRenameLabel("");
    setRenameConflict(false);
    setRenameNotice(null);
    setSelectedAdult(null);
    setMoveTargetHouseholdId("");
    setMoveConflict(false);
    setMoveNotice(null);
    setAdultSearchDraft("");
    setAdultSearchResults(null);
    setAdultSearchNextCursor(null);
    setAdultSearchLoading(false);
    setAdultSearchError(false);
    setAdultSearchNotice(null);
    adultSearchGeneration.current += 1;
    setMinorGivenName("");
    setMinorFamilyName("");
    setMinorDob("");
    setMinorGuardianId("");
    setMinorRights(initialRights);
    setAddMinorNotice(null);
    setLinkGuardianId("");
    setLinkChildId("");
    setLinkRights(initialRights);
    setLinkNotice(null);
    setUnlinkingLinkId(null);
    setUnlinkNotice(null);
    setPaymentRequired(false);
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
    setUnlinkingLinkId(null);
    setUnlinkNotice(null);
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
    setCreateLabel("");
    setCreateNotice(null);
    reloadList();
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

  function openCreate() {
    setCreateLabel("");
    setCreateNotice(null);
    setView("create");
  }

  function openRename() {
    setRenameLabel(detailHousehold?.label ?? "");
    setRenameConflict(false);
    setRenameNotice(null);
    setView("rename");
  }

  function handleReloadFromConflict() {
    setRenameConflict(false);
    setRenameNotice(null);
    setRenameLabel("");
    reloadDetail();
    setView("detail");
  }

  function clearAdultSearch() {
    setAdultSearchDraft("");
    setAdultSearchResults(null);
    setAdultSearchNextCursor(null);
    setAdultSearchLoading(false);
    setAdultSearchError(false);
    setAdultSearchNotice(null);
    adultSearchGeneration.current += 1;
  }

  function openMoveAdult(adult: AdultMember) {
    setSelectedAdult(adult);
    setMoveTargetHouseholdId("");
    setMoveConflict(false);
    setMoveNotice(null);
    setView("move-adult");
  }

  function openAddAdult() {
    clearAdultSearch();
    setView("add-adult");
  }

  function handleReloadFromMoveConflict() {
    setMoveConflict(false);
    setMoveNotice(null);
    setSelectedAdult(null);
    setMoveTargetHouseholdId("");
    reloadDetail();
    setView("detail");
  }

  function openAddMinor() {
    setMinorGivenName("");
    setMinorFamilyName("");
    setMinorDob("");
    setMinorGuardianId(detailHousehold?.adults[0]?.personId ?? "");
    setMinorRights(initialRights);
    setAddMinorNotice(null);
    setView("add-minor");
  }

  function openLinkGuardian() {
    setLinkGuardianId(detailHousehold?.adults[0]?.personId ?? "");
    setLinkChildId(detailHousehold?.minors?.[0]?.personId ?? "");
    setLinkRights(initialRights);
    setLinkNotice(null);
    setView("link-guardian");
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !slug) {
      return;
    }
    setSubmitting(true);
    setCreateNotice(null);

    try {
      const response = await post("/v1/households/create", {
        communitySlug: slug,
        label: createLabel.trim() || null,
      });

      if (response === "unavailable") {
        setCreateNotice("Unable to create household");
        return;
      }

      if (response.status === 400) {
        setCreateNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setCreateNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setCreateNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setCreateNotice("Not found");
        return;
      }

      if (response.status === 201) {
        let createdId: string | null = null;
        try {
          const data: unknown = await response.json();
          if (isRecord(data) && typeof data.householdId === "string") {
            createdId = data.householdId;
          }
        } catch {
          createdId = null;
        }
        setCreateLabel("");
        reloadList();
        if (createdId !== null) {
          openDetail(createdId);
        } else {
          setView("list");
        }
        return;
      }

      setCreateNotice("Unable to create household");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdultSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slug || adultSearchLoading) {
      return;
    }
    const search = adultSearchDraft.trim();
    const mine = ++adultSearchGeneration.current;
    setAdultSearchLoading(true);
    setAdultSearchError(false);
    setAdultSearchNotice(null);
    setAdultSearchResults(null);
    setAdultSearchNextCursor(null);

    const body: Record<string, unknown> = {
      communitySlug: slug,
      kind: "adults",
    };
    if (search) {
      body.search = search;
    }
    const response = await post("/v1/people/list", body);
    if (adultSearchGeneration.current !== mine) {
      return;
    }
    setAdultSearchLoading(false);

    if (response === "unavailable") {
      setAdultSearchError(true);
      return;
    }

    if (response.status === 402) {
      setPaymentRequired(true);
      void refreshBilling();
      setAdultSearchNotice("Read-only until billing is settled");
      return;
    }

    if (response.status === 400) {
      setAdultSearchNotice("Invalid input");
      return;
    }

    if (response.status === 403) {
      setAdultSearchNotice("Not allowed");
      return;
    }

    if (response.status === 404) {
      setAdultSearchNotice("Not found");
      return;
    }

    if (response.status !== 200) {
      setAdultSearchError(true);
      return;
    }

    try {
      const data: unknown = await response.json();
      if (adultSearchGeneration.current !== mine) {
        return;
      }
      const parsed = parseAdultSearchResponse(data);
      if (parsed === null) {
        setAdultSearchError(true);
        return;
      }
      const existingIds = new Set((detailHousehold?.adults ?? []).map((a) => a.personId));
      setAdultSearchResults(parsed.items.filter((item) => !existingIds.has(item.personId)));
      setAdultSearchNextCursor(parsed.nextCursor);
    } catch {
      if (adultSearchGeneration.current !== mine) {
        return;
      }
      setAdultSearchError(true);
    }
  }

  async function handleAddAdultToHousehold(adult: AdultSearchItem) {
    if (submitting || !slug || !detailHousehold || !canAddAdult) {
      return;
    }
    setSubmitting(true);
    setAdultSearchNotice(null);

    try {
      const response = await post("/v1/households/members/move-adult", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        personId: adult.personId,
        version: adult.version,
      });

      if (response === "unavailable") {
        setAdultSearchNotice("Unable to move adult");
        return;
      }

      if (response.status === 409) {
        setAdultSearchNotice(
          "This change could not be applied. The adult may have guardian links, or they changed. Search again to see the latest.",
        );
        setAdultSearchResults(null);
        setAdultSearchNextCursor(null);
        return;
      }

      if (response.status === 400) {
        setAdultSearchNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setAdultSearchNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setAdultSearchNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setAdultSearchNotice("Not found");
        return;
      }

      if (response.status === 200) {
        clearAdultSearch();
        setView("detail");
        reloadDetail();
        return;
      }

      setAdultSearchNotice("Unable to move adult");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !slug || !detailHousehold) {
      return;
    }
    setSubmitting(true);
    setRenameConflict(false);
    setRenameNotice(null);

    try {
      const response = await post("/v1/households/rename", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        version: detailHousehold.version,
        label: renameLabel.trim() || null,
      });

      if (response === "unavailable") {
        setRenameNotice("Unable to rename household");
        return;
      }

      if (response.status === 409) {
        setRenameConflict(true);
        return;
      }

      if (response.status === 400) {
        setRenameNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setRenameNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setRenameNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setRenameNotice("Household not found");
        return;
      }

      if (response.status === 200) {
        setView("detail");
        reloadDetail();
        return;
      }

      setRenameNotice("Unable to rename household");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMoveAdultSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !slug || !selectedAdult) {
      return;
    }
    setSubmitting(true);
    setMoveConflict(false);
    setMoveNotice(null);

    try {
      const response = await post("/v1/households/members/move-adult", {
        communitySlug: slug,
        householdId: moveTargetHouseholdId.trim() || null,
        personId: selectedAdult.personId,
        version: selectedAdult.version,
      });

      if (response === "unavailable") {
        setMoveNotice("Unable to move adult");
        return;
      }

      if (response.status === 409) {
        setMoveConflict(true);
        return;
      }

      if (response.status === 400) {
        setMoveNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setMoveNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setMoveNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setMoveNotice("Not found");
        return;
      }

      if (response.status === 200) {
        setSelectedAdult(null);
        setView("detail");
        reloadDetail();
        return;
      }

      setMoveNotice("Unable to move adult");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddMinorSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !slug || !detailHousehold || !canAddMinor) {
      return;
    }
    if (!minorRights.consent && !minorRights.pickup && !minorRights.view && !minorRights.manage) {
      setAddMinorNotice("Invalid input");
      return;
    }
    setSubmitting(true);
    setAddMinorNotice(null);

    try {
      const response = await post("/v1/households/members/add-minor", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        givenName: minorGivenName.trim(),
        familyName: minorFamilyName.trim(),
        dateOfBirth: minorDob.trim(),
        guardianId: minorGuardianId,
        rights: minorRights,
      });

      if (response === "unavailable") {
        setAddMinorNotice("Unable to add minor");
        return;
      }

      if (response.status === 400) {
        setAddMinorNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setAddMinorNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setAddMinorNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setAddMinorNotice("Not found");
        return;
      }

      if (response.status === 409) {
        setAddMinorNotice("Conflict");
        return;
      }

      if (response.status === 201) {
        setMinorGivenName("");
        setMinorFamilyName("");
        setMinorDob("");
        setMinorGuardianId("");
        setMinorRights(initialRights);
        setView("detail");
        reloadDetail();
        return;
      }

      setAddMinorNotice("Unable to add minor");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLinkGuardianSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !slug || !detailHousehold || !canLinkGuardian) {
      return;
    }
    if (!linkRights.consent && !linkRights.pickup && !linkRights.view && !linkRights.manage) {
      setLinkNotice("Invalid input");
      return;
    }
    setSubmitting(true);
    setLinkNotice(null);

    try {
      const response = await post("/v1/households/guardians/link", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        guardianId: linkGuardianId,
        childId: linkChildId,
        rights: linkRights,
      });

      if (response === "unavailable") {
        setLinkNotice("Unable to link guardian");
        return;
      }

      if (response.status === 409) {
        setLinkNotice("This guardian link already exists");
        return;
      }

      if (response.status === 400) {
        setLinkNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setLinkNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setLinkNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setLinkNotice("Not found");
        return;
      }

      if (response.status === 201) {
        setLinkGuardianId("");
        setLinkChildId("");
        setLinkRights(initialRights);
        setView("detail");
        reloadDetail();
        return;
      }

      setLinkNotice("Unable to link guardian");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmUnlink(linkId: string) {
    if (submitting || !slug || !detailHousehold || !canUnlinkGuardian) {
      return;
    }
    setSubmitting(true);
    setUnlinkNotice(null);

    try {
      const response = await post("/v1/households/guardians/unlink", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        linkId,
      });

      setUnlinkingLinkId(null);

      if (response === "unavailable") {
        setUnlinkNotice("Unable to remove guardian link");
        return;
      }

      if (response.status === 409) {
        setUnlinkNotice("Cannot remove the last guardian");
        return;
      }

      if (response.status === 400) {
        setUnlinkNotice("Invalid input");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        setUnlinkNotice("Read-only until billing is settled");
        return;
      }

      if (response.status === 403) {
        setUnlinkNotice("Not allowed");
        return;
      }

      if (response.status === 404) {
        setUnlinkNotice("Not found");
        return;
      }

      if (response.status === 200) {
        detailHeadingRef.current?.focus();
        reloadDetail();
        return;
      }

      setUnlinkNotice("Unable to remove guardian link");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (!access.entitlements["people.households"] || !access.permissions["people.view"]) {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  if (view === "create") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={createHeadingRef} tabIndex={-1}>
          Create Household
        </h2>

        {createNotice ? (
          <Alert ref={createAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{createNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleCreateSubmit}>
          <div>
            <label htmlFor="create-household-label">Household name (optional)</label>
            <Input
              id="create-household-label"
              value={createLabel}
              onChange={(e) => setCreateLabel(e.target.value)}
            />
          </div>

          <div>
            <Button type="submit" disabled={submitting}>
              Save household
            </Button>
            <Button type="button" variant="outline" onClick={backToList}>
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  if (view === "rename") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={renameHeadingRef} tabIndex={-1}>
          Rename Household
        </h2>

        {renameConflict ? (
          <Alert ref={renameAlertRef} tabIndex={-1} role="alert">
            <span>
              This household was changed by someone else. Reload to see the latest details; your
              unsaved changes will be discarded.
            </span>
            <Button type="button" onClick={handleReloadFromConflict}>
              Reload
            </Button>
          </Alert>
        ) : null}

        {renameNotice ? (
          <Alert ref={renameAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{renameNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleRenameSubmit}>
          <div>
            <label htmlFor="rename-household-label">Household name</label>
            <Input
              id="rename-household-label"
              value={renameLabel}
              onChange={(e) => setRenameLabel(e.target.value)}
            />
          </div>

          <div>
            <Button type="submit" disabled={submitting}>
              Save changes
            </Button>
            <Button type="button" variant="outline" onClick={() => setView("detail")}>
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  if (view === "add-adult") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={addAdultHeadingRef} tabIndex={-1}>
          Add Adult
        </h2>

        {adultSearchNotice ? (
          <Alert ref={addAdultAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{adultSearchNotice}</span>
          </Alert>
        ) : null}

        {adultSearchError ? (
          <Alert variant="destructive" live="assertive">
            <span>Failed to search adults</span>
          </Alert>
        ) : null}

        <form onSubmit={handleAdultSearch}>
          <div>
            <label htmlFor="add-adult-search">Search adults</label>
            <Input
              id="add-adult-search"
              value={adultSearchDraft}
              onChange={(e) => setAdultSearchDraft(e.target.value)}
            />
          </div>
          <div>
            <Button type="submit" disabled={adultSearchLoading}>
              Search
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                clearAdultSearch();
                setView("detail");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>

        {adultSearchLoading ? <p>Searching...</p> : null}

        {adultSearchResults !== null && adultSearchResults.length === 0 ? (
          <p>No adults found</p>
        ) : null}

        {adultSearchResults !== null && adultSearchResults.length > 0 ? (
          <>
            <Table aria-label="Adult search results">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Given name</TableHead>
                  <TableHead scope="col">Family name</TableHead>
                  <TableHead scope="col">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adultSearchResults.map((adult) => (
                  <TableRow key={adult.personId}>
                    <TableCell>{adult.givenName}</TableCell>
                    <TableCell>{adult.familyName}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        disabled={submitting}
                        aria-label={`Add ${adult.givenName} ${adult.familyName} to household`}
                        onClick={() => void handleAddAdultToHousehold(adult)}
                      >
                        Add to household
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {adultSearchNextCursor !== null ? <p>More results exist. Refine your search.</p> : null}
          </>
        ) : null}
      </>
    );
  }

  if (view === "move-adult") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={moveAdultHeadingRef} tabIndex={-1}>
          Move Adult
        </h2>

        {moveConflict ? (
          <Alert ref={moveAlertRef} tabIndex={-1} role="alert">
            <span>
              This change could not be applied. The adult may have guardian links, or the household
              changed. Reload to see the latest.
            </span>
            <Button type="button" onClick={handleReloadFromMoveConflict}>
              Reload
            </Button>
          </Alert>
        ) : null}

        {moveNotice ? (
          <Alert ref={moveAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{moveNotice}</span>
          </Alert>
        ) : null}

        {selectedAdult ? (
          <p>
            <strong>Adult:</strong> {selectedAdult.givenName} {selectedAdult.familyName}
          </p>
        ) : null}

        <form onSubmit={handleMoveAdultSubmit}>
          <div>
            <label htmlFor="move-adult-target">Target household</label>
            <p id="move-adult-target-hint">
              Select a target household, or choose &quot;No household&quot; to remove from
              household.
            </p>
            {nextCursor !== null ? (
              <p id="move-adult-paged-notice">
                The household list is paged. Only currently loaded households are offered.
              </p>
            ) : null}
            <select
              id="move-adult-target"
              aria-describedby={
                nextCursor !== null
                  ? "move-adult-target-hint move-adult-paged-notice"
                  : "move-adult-target-hint"
              }
              value={moveTargetHouseholdId}
              onChange={(e) => setMoveTargetHouseholdId(e.target.value)}
            >
              <option value="">No household</option>
              {(items ?? []).map((h) => (
                <option key={h.householdId} value={h.householdId}>
                  {h.label ? h.label : h.householdId}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Button type="submit" disabled={submitting}>
              Save move
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelectedAdult(null);
                setMoveTargetHouseholdId("");
                setMoveConflict(false);
                setMoveNotice(null);
                setView("detail");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  if (view === "add-minor") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={addMinorHeadingRef} tabIndex={-1}>
          Add Minor
        </h2>

        {addMinorNotice ? (
          <Alert ref={addMinorAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{addMinorNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleAddMinorSubmit}>
          <div>
            <label htmlFor="minor-given-name">Given name</label>
            <Input
              id="minor-given-name"
              value={minorGivenName}
              onChange={(e) => setMinorGivenName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="minor-family-name">Family name</label>
            <Input
              id="minor-family-name"
              value={minorFamilyName}
              onChange={(e) => setMinorFamilyName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="minor-dob">Date of birth</label>
            <Input
              id="minor-dob"
              type="date"
              value={minorDob}
              onChange={(e) => setMinorDob(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="minor-guardian">Guardian</label>
            <select
              id="minor-guardian"
              value={minorGuardianId}
              onChange={(e) => setMinorGuardianId(e.target.value)}
              required
            >
              <option value="">Select guardian</option>
              {detailHousehold?.adults.map((adult) => (
                <option key={adult.personId} value={adult.personId}>
                  {adult.givenName} {adult.familyName}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend>Guardian rights</legend>
            <label>
              <input
                type="checkbox"
                checked={minorRights.consent}
                onChange={(e) => setMinorRights((r) => ({ ...r, consent: e.target.checked }))}
              />{" "}
              Consent
            </label>
            <label>
              <input
                type="checkbox"
                checked={minorRights.pickup}
                onChange={(e) => setMinorRights((r) => ({ ...r, pickup: e.target.checked }))}
              />{" "}
              Pickup
            </label>
            <label>
              <input
                type="checkbox"
                checked={minorRights.view}
                onChange={(e) => setMinorRights((r) => ({ ...r, view: e.target.checked }))}
              />{" "}
              View
            </label>
            <label>
              <input
                type="checkbox"
                checked={minorRights.manage}
                onChange={(e) => setMinorRights((r) => ({ ...r, manage: e.target.checked }))}
              />{" "}
              Manage
            </label>
          </fieldset>

          <div>
            <Button type="submit" disabled={submitting}>
              Save minor
            </Button>
            <Button type="button" variant="outline" onClick={() => setView("detail")}>
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  if (view === "link-guardian") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <h2 ref={linkGuardianHeadingRef} tabIndex={-1}>
          Link Guardian
        </h2>

        {linkNotice ? (
          <Alert ref={linkAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{linkNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleLinkGuardianSubmit}>
          <div>
            <label htmlFor="link-guardian-adult">Guardian</label>
            <select
              id="link-guardian-adult"
              value={linkGuardianId}
              onChange={(e) => setLinkGuardianId(e.target.value)}
              required
            >
              <option value="">Select guardian</option>
              {detailHousehold?.adults.map((adult) => (
                <option key={adult.personId} value={adult.personId}>
                  {adult.givenName} {adult.familyName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="link-guardian-child">Child</label>
            <select
              id="link-guardian-child"
              value={linkChildId}
              onChange={(e) => setLinkChildId(e.target.value)}
              required
            >
              <option value="">Select child</option>
              {detailHousehold?.minors?.map((minor) => (
                <option key={minor.personId} value={minor.personId}>
                  {minor.givenName} {minor.familyName}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend>Guardian rights</legend>
            <label>
              <input
                type="checkbox"
                checked={linkRights.consent}
                onChange={(e) => setLinkRights((r) => ({ ...r, consent: e.target.checked }))}
              />{" "}
              Consent
            </label>
            <label>
              <input
                type="checkbox"
                checked={linkRights.pickup}
                onChange={(e) => setLinkRights((r) => ({ ...r, pickup: e.target.checked }))}
              />{" "}
              Pickup
            </label>
            <label>
              <input
                type="checkbox"
                checked={linkRights.view}
                onChange={(e) => setLinkRights((r) => ({ ...r, view: e.target.checked }))}
              />{" "}
              View
            </label>
            <label>
              <input
                type="checkbox"
                checked={linkRights.manage}
                onChange={(e) => setLinkRights((r) => ({ ...r, manage: e.target.checked }))}
              />{" "}
              Manage
            </label>
          </fieldset>

          <div>
            <Button type="submit" disabled={submitting}>
              Save link
            </Button>
            <Button type="button" variant="outline" onClick={() => setView("detail")}>
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  const adultColumns: DataTableColumn<AdultMember>[] = [
    {
      key: "givenName",
      header: "Given name",
      primary: true,
      render: (adult) => (
        <span className="flex items-center gap-2">
          <Avatar name={`${adult.givenName} ${adult.familyName}`} />
          <span>{adult.givenName}</span>
        </span>
      ),
    },
    {
      key: "familyName",
      header: "Family name",
      render: (adult) => adult.familyName,
    },
    ...(canMoveAdult
      ? [
          {
            key: "actions",
            header: "Actions",
            render: (adult: AdultMember) => (
              <Button
                type="button"
                variant="outline"
                aria-label={`Move ${adult.givenName} ${adult.familyName}`}
                onClick={() => openMoveAdult(adult)}
              >
                Move adult
              </Button>
            ),
          },
        ]
      : []),
  ];

  if (view === "detail") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        {isReadOnly ? (
          <Alert live="polite">
            <span>Read-only until billing is settled</span>{" "}
            <Link to="/settings/general">General Settings</Link>
          </Alert>
        ) : null}

        {!canRestricted ? (
          <Alert live="polite">Household names and children are hidden for your role.</Alert>
        ) : null}

        {unlinkNotice ? (
          <Alert ref={unlinkAlertRef} tabIndex={-1} variant="destructive" role="alert">
            <span>{unlinkNotice}</span>
          </Alert>
        ) : null}

        <Panel
          title="Household Details"
          level={2}
          headingRef={detailHeadingRef}
          headingTabIndex={-1}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={backToList}>
                Back to list
              </Button>
              {canRename && detailHousehold ? (
                <Button type="button" onClick={openRename}>
                  Rename household
                </Button>
              ) : null}
            </div>
          }
        >
          {detailLoading ? (
            <>
              <Skeleton />
              <span className="sr-only">Loading household details...</span>
            </>
          ) : null}

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

          {!detailLoading && !detailNotFound && !detailError && detailHousehold?.label ? (
            <p>
              <strong>Household name:</strong> {detailHousehold.label}
            </p>
          ) : null}
        </Panel>

        {!detailLoading && !detailNotFound && !detailError && detailHousehold ? (
          <>
            <Panel
              title="Adults"
              level={3}
              actions={
                canAddAdult ? (
                  <Button type="button" onClick={openAddAdult}>
                    Add adult
                  </Button>
                ) : null
              }
            >
              {detailHousehold.adults.length === 0 ? (
                <p>No adult members</p>
              ) : (
                <DataTable
                  aria-label="Adult members"
                  rowKey={(adult) => adult.personId}
                  rows={detailHousehold.adults}
                  columns={adultColumns}
                />
              )}

              {canReadLifeEvents
                ? detailHousehold.adults.map((adult) => (
                    <LifeEventsPanel
                      key={adult.personId}
                      personId={adult.personId}
                      personName={`${adult.givenName} ${adult.familyName}`}
                      isReadOnly={isReadOnly}
                      canManage={canManage && !hideWrites}
                    />
                  ))
                : null}
            </Panel>

            {access.permissions["people.restricted.read"] && detailHousehold.minors ? (
              <MinorsSection
                detailHousehold={detailHousehold}
                access={access}
                isReadOnly={isReadOnly}
                canManage={canManage && !hideWrites}
                unlinkingLinkId={unlinkingLinkId}
                submitting={submitting}
                openAddMinor={openAddMinor}
                openLinkGuardian={openLinkGuardian}
                handleConfirmUnlink={handleConfirmUnlink}
                setUnlinkingLinkId={setUnlinkingLinkId}
                setUnlinkNotice={setUnlinkNotice}
              />
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ScreenTitle ref={listHeadingRef}>Family Records</ScreenTitle>

      {isReadOnly ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>{" "}
          <Link to="/settings/general">General Settings</Link>
        </Alert>
      ) : null}

      {!canRestricted ? (
        <Alert live="polite">Household names and children are hidden for your role.</Alert>
      ) : null}

      {canCreate ? (
        <div>
          <Button type="button" onClick={openCreate}>
            Create household
          </Button>
        </div>
      ) : null}

      {loading && items === null ? (
        <>
          <Skeleton />
          <span className="sr-only">Loading households...</span>
        </>
      ) : null}

      {error ? (
        <Alert variant="destructive" live="assertive">
          <span>Failed to load households</span>
          <Button type="button" onClick={reloadList}>
            Retry
          </Button>
        </Alert>
      ) : null}

      {!error && items !== null ? (
        items.length === 0 ? (
          <EmptyState message="No households yet" />
        ) : (
          <>
            <DataTable
              aria-label="Households"
              rowKey={(household) => household.householdId}
              columns={[
                {
                  key: "household",
                  header: "Household",
                  primary: true,
                  render: (household) =>
                    household.label !== null ? (
                      household.label
                    ) : canRestricted ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <RestrictedValue label="Household name hidden for your role" />
                    ),
                },
                {
                  key: "adults",
                  header: "Adults",
                  render: (household) => household.adultCount,
                },
                {
                  key: "actions",
                  header: "Actions",
                  render: (household) => (
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={`View ${household.label ?? "household"}`}
                      onClick={() => openDetail(household.householdId)}
                    >
                      View
                    </Button>
                  ),
                },
              ]}
              rows={items}
            />

            <Pagination cursor={nextCursor} onNext={handleNextPage} />
          </>
        )
      ) : null}
    </>
  );
}
