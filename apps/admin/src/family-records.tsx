import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  EmptyState,
  Field,
  FilterBar,
  Input,
  Pagination,
  Panel,
  RestrictedValue,
  Select,
  Skeleton,
  StatusBadge,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { ChildValue, ChildViewProvider, type StaleReason } from "./child-view";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { type ContactFormData, ContactFields, initialFormData } from "./contact-fields";
import { duplicateDeletedMessage, readErrorCode } from "./duplicate-deleted";
import { useEmergencyContacts } from "./emergency-contacts-panel";
import {
  deletedColumns,
  type FamilyStatus,
  type HouseholdItem,
  parseDeletedItem,
  readFamilyStatus,
  StatusFilterSelect,
  type StatusFilter,
  statusColumn,
  useFamilyDelete,
  useFamilyListActions,
} from "./family-status";
import { LifeEventsPanel } from "./life-events";
import { type PeopleAccess, usePeopleAccess } from "./people-access";
import { ScreenTitle } from "./screen-title";
import { isUnder18OnSydneyDate } from "./sydney-age";

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

// A child as the family read shows one: an id and the label "Child n", and nothing else. Every field
// of a child is read on its own, with a View (ADR 0017).
type ChildRef = {
  personId: string;
  label: string;
};

// How many children a family has, for everyone who may see the family. A Community Admin also gets
// each child as an id and a label: that is how this screen knows which of the two it is showing.
export type HouseholdMinors = {
  childCount: number;
  children?: ChildRef[] | undefined;
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
  // Present for a Community Admin only.
  child?: ChildRef | undefined;
  rights: GuardianRights;
};

export type HouseholdDetail = {
  householdId: string;
  version: number;
  status?: FamilyStatus;
  label: string | null;
  adults: AdultMember[];
  minors?: HouseholdMinors | undefined;
  guardians: GuardianLink[];
};

type ViewMode =
  | "list"
  | "detail"
  | "create"
  | "rename"
  | "move-adult"
  | "add-adult"
  | "add-adult-new"
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
    status: readFamilyStatus(item.status),
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

function parseListResponse(value: unknown, deleted: boolean): ListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: HouseholdItem[] = [];
  for (const item of value.items) {
    const parsed = deleted ? parseDeletedItem(item) : parseHouseholdItem(item);
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

// Only the id and the label are taken. Whatever else an answer carries about a child is dropped here,
// so no screen below can show it.
function parseChildRef(value: unknown): ChildRef | null {
  if (!isRecord(value) || typeof value.personId !== "string" || typeof value.label !== "string") {
    return null;
  }
  return { personId: value.personId, label: value.label };
}

function parseMinors(value: unknown): HouseholdMinors | undefined {
  if (
    !isRecord(value) ||
    typeof value.childCount !== "number" ||
    !Number.isInteger(value.childCount) ||
    value.childCount < 0
  ) {
    return undefined;
  }
  if (!Array.isArray(value.children)) {
    return { childCount: value.childCount };
  }
  const children: ChildRef[] = [];
  for (const item of value.children) {
    const parsed = parseChildRef(item);
    if (parsed !== null) {
      children.push(parsed);
    }
  }
  return { childCount: value.childCount, children };
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
  const child = parseChildRef(value.child);
  return {
    linkId: value.linkId,
    guardianId: value.guardianId,
    childId: value.childId,
    ...(child === null ? {} : { child }),
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
  const minors = parseMinors(value.minors);
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
    status: readFamilyStatus(value.status),
    label: typeof value.label === "string" ? value.label : null,
    adults,
    guardians,
  };
  if (minors !== undefined) {
    detail.minors = minors;
  }
  return detail;
}

type ListQuery = { slug: string; status: StatusFilter; cursor: string | undefined };

const NO_QUERY: ListQuery = { slug: "", status: "", cursor: undefined };

const initialRights: GuardianRights = {
  consent: true,
  pickup: false,
  view: true,
  manage: false,
};

// What the guidance under the household name says, on the create form and on the rename form. The
// service refuses a name that holds a child's given name, and says nothing about which.
const LABEL_GUIDANCE = "Use the family name. Don't include a child's name.";
const LABEL_REFUSED = "The household name can't include a child's name. Use the family name.";
const LABEL_REFUSED_FOR_NEW_CHILD =
  "The household name includes this child's name. Rename the household to the family name only, then add the child.";

function childCountText(count: number): string {
  return `${count} ${count === 1 ? "child" : "children"} in this family`;
}

// A Community Admin is the only one the service sends the children to, as ids and labels, and the
// capabilities answer says who that is. The service stays the authority: a family read with no
// `children` shows the count only, whoever reads it, and a caller who is not a Community Admin never
// shows a child even if an answer carried them.
function isChildAdmin(detail: HouseholdDetail | null, communityAdmin: boolean): boolean {
  return communityAdmin && detail?.minors?.children !== undefined;
}

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
  // Called when a View finds that the child or the caller's role has changed since the family was
  // read, so the family can be read again.
  onStale?: (reason: StaleReason) => void;
};

function getGuardianLinkDetails(link: GuardianLink, household: HouseholdDetail) {
  const guardian = household.adults.find((a) => a.personId === link.guardianId);
  const child = link.child ?? household.minors?.children?.find((c) => c.personId === link.childId);
  const guardianName = guardian ? `${guardian.givenName} ${guardian.familyName}` : link.guardianId;
  const childName = child ? child.label : "Child";
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
  onStale,
}: MinorsSectionProps) {
  const minors = detailHousehold.minors;
  const canManage = canManageProp ?? Boolean(access.permissions["people.manage"]);
  if (minors === undefined) {
    return null;
  }

  // Everyone but a Community Admin sees how many children there are, and nothing else of them: no
  // label, no id, no guardian link.
  if (!isChildAdmin(detailHousehold, access.roles.communityAdmin)) {
    return minors.childCount === 0 ? null : (
      <Panel title="Children" level={3}>
        <p>{childCountText(minors.childCount)}</p>
      </Panel>
    );
  }

  const children = minors.children ?? [];
  const canReadLifeEvents = Boolean(access.entitlements["people.households"]);
  const canAddMinor = canManage && !isReadOnly;
  const canLinkGuardian = canManage && !isReadOnly;
  const canUnlinkGuardian = canManage && !isReadOnly;

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
                    size="sm"
                    disabled={submitting}
                    onClick={() => handleConfirmUnlink?.(link.linkId)}
                  >
                    Confirm unlink
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
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
                  size="sm"
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
        <ChildViewProvider onStale={onStale}>
          {children.length === 0 ? (
            <p>No minor members</p>
          ) : (
            children.map((child) => (
              <div
                key={child.personId}
                className="grid gap-2 rounded-md border border-border p-3"
                data-testid={`child-${child.personId}`}
              >
                <h4 className="font-semibold text-foreground text-base leading-[22px]">
                  {child.label}
                </h4>
                <DescriptionList
                  items={[
                    {
                      term: "Name",
                      value: (
                        <ChildValue
                          target={{ personId: child.personId, field: "name" }}
                          fieldName="name"
                          subject={child.label}
                        />
                      ),
                    },
                    {
                      term: "Date of birth",
                      value: (
                        <ChildValue
                          target={{ personId: child.personId, field: "dateOfBirth" }}
                          fieldName="date of birth"
                          subject={child.label}
                        />
                      ),
                    },
                    {
                      term: "Email",
                      value: (
                        <ChildValue
                          target={{ personId: child.personId, field: "email" }}
                          fieldName="email"
                          subject={child.label}
                        />
                      ),
                    },
                    {
                      term: "Phone",
                      value: (
                        <ChildValue
                          target={{ personId: child.personId, field: "phone" }}
                          fieldName="phone"
                          subject={child.label}
                        />
                      ),
                    },
                  ]}
                />
                {canReadLifeEvents ? (
                  <LifeEventsPanel
                    personId={child.personId}
                    personName={child.label}
                    isReadOnly={isReadOnly}
                    canManage={canManage}
                    child
                  />
                ) : null}
              </div>
            ))
          )}
        </ChildViewProvider>
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
  const [listQuery, setListQuery] = useState<ListQuery>(NO_QUERY);
  const [itemsDeleted, setItemsDeleted] = useState(false);
  const [listAlert, setListAlert] = useState<string | null>(null);
  const [headingFocusPending, setHeadingFocusPending] = useState(false);
  const [alertFocusPending, setAlertFocusPending] = useState(false);
  const listAlertRef = useRef<HTMLDivElement>(null);
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

  // Create new adult
  const [newAdultForm, setNewAdultForm] = useState<ContactFormData>(initialFormData);
  const [newAdultNotice, setNewAdultNotice] = useState<string | null>(null);
  const [newAdultNotFound, setNewAdultNotFound] = useState(false);
  const submittingRef = useRef(false);

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
  const newAdultHeadingRef = useRef<HTMLHeadingElement>(null);
  const addMinorHeadingRef = useRef<HTMLHeadingElement>(null);
  const linkGuardianHeadingRef = useRef<HTMLHeadingElement>(null);

  // Ref alerts for screen reader focus
  const createAlertRef = useRef<HTMLDivElement>(null);
  const renameAlertRef = useRef<HTMLDivElement>(null);
  const moveAlertRef = useRef<HTMLDivElement>(null);
  const addAdultAlertRef = useRef<HTMLDivElement>(null);
  const newAdultAlertRef = useRef<HTMLDivElement>(null);
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
    } else if (view === "add-adult-new") {
      newAdultHeadingRef.current?.focus();
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
    if (newAdultNotice) {
      newAdultAlertRef.current?.focus();
    }
  }, [newAdultNotice]);

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
  // Counts the answers to the detail read, so the emergency contacts can tell a reload has answered.
  const detailAnswers = useRef(0);
  // Changes only with the community or the open family, never when the detail reloads.
  const panelGeneration = useRef(0);

  const isReadOnly = status?.state === "none" || status?.state === "read_only" || paymentRequired;
  const hideWrites = readiness === "loading" || isReadOnly;

  const canManage = Boolean(access.permissions["people.manage"]);
  const canRestricted = Boolean(access.permissions["people.restricted.read"]);
  const canReadLifeEvents = canRestricted && Boolean(access.entitlements["people.households"]);
  // Only a Community Admin is sent the children, as ids and labels. Everyone else is sent a count.
  const communityAdmin = access.roles.communityAdmin;
  const childAdmin = isChildAdmin(detailHousehold, communityAdmin);
  const hasChildren = (detailHousehold?.minors?.childCount ?? 0) > 0;

  const canCreate = canManage && !hideWrites;
  // A family with a child is renamed by a Community Admin only: the service refuses anyone else.
  const canRename = canManage && canRestricted && !hideWrites && (!hasChildren || communityAdmin);
  const canMoveAdult = canManage && canRestricted && !hideWrites;
  const canAddAdult = canMoveAdult && Boolean(access.entitlements["people.directory"]);
  const canAddMinor = childAdmin && canManage && !hideWrites;
  const canLinkGuardian = childAdmin && canManage && !hideWrites;
  const canUnlinkGuardian = childAdmin && canManage && !hideWrites;

  // Delete, restore and the Deleted filter need all three keys, and are never shown disabled.
  const canFilterDeleted =
    Boolean(access.permissions["people.view"]) &&
    Boolean(access.permissions["people.delete"]) &&
    canRestricted;
  const canDeleteFamily = canFilterDeleted && !hideWrites;
  const stored = listQuery.slug === slug ? listQuery : NO_QUERY;
  // Losing a key while on the Deleted filter goes back to All; deleted rows are never shown.
  const statusFilter: StatusFilter =
    stored.status === "deleted" && !canFilterDeleted ? "" : stored.status;
  const cursor = stored.status === statusFilter ? stored.cursor : undefined;
  const deletedView = statusFilter === "deleted";

  // An answer that belongs to an earlier community or filter is ignored.
  const scope = useRef(0);
  const community = useRef(0);
  useEffect(() => {
    scope.current += 1;
  }, [slug, statusFilter]);
  useEffect(() => {
    community.current += 1;
  }, [slug]);

  // A reload after a late answer asks for the list on screen, not the one of the render that sent it.
  const latestQuery = useRef({ slug, statusFilter, cursor });
  useEffect(() => {
    latestQuery.current = { slug, statusFilter, cursor };
  });

  useEffect(() => {
    if (stored.status === "deleted" && !canFilterDeleted) {
      setListQuery({ slug, status: "", cursor: undefined });
    }
  }, [stored.status, canFilterDeleted, slug]);

  function onPaymentRequired() {
    setPaymentRequired(true);
    void refreshBilling();
  }

  const familyActions = useFamilyListActions({
    slug,
    scope,
    community,
    statusFilter,
    setItems,
    setAlert: setListAlert,
    applyAnswer: (householdId, newVersion, newStatus) => {
      emergency.noteVersion(householdId, newVersion);
      setDetailHousehold((prev) =>
        prev !== null && prev.householdId === householdId
          ? { ...prev, version: newVersion, status: newStatus }
          : prev,
      );
    },
    reloadList,
    focusHeading: () => setHeadingFocusPending(true),
    focusAlert: () => setAlertFocusPending(true),
    onPaymentRequired,
  });
  const familyDelete = useFamilyDelete({
    slug,
    panel: panelGeneration,
    onDone: () => {
      backToList();
      setHeadingFocusPending(true);
    },
    onPaymentRequired,
    focusFallback: () => detailHeadingRef.current?.focus(),
  });
  const emergency = useEmergencyContacts({
    slug,
    householdId: detailHousehold?.householdId ?? null,
    detailVersion: detailHousehold?.version ?? 0,
    detailAnswers,
    detailFailed: detailError || detailNotFound,
    canRead: canRestricted,
    canEdit: canManage && !hideWrites,
    gone: detailNotFound,
    onSaved: (householdId, newVersion) => {
      setDetailHousehold((prev) =>
        prev !== null && prev.householdId === householdId ? { ...prev, version: newVersion } : prev,
      );
      setItems((prev) =>
        prev === null
          ? prev
          : prev.map((item) =>
              item.householdId === householdId ? { ...item, version: newVersion } : item,
            ),
      );
    },
    onConflict: () => reloadDetail(),
    onGone: () => reloadDetail(),
    onPaymentRequired,
  });

  // After a restore, or when a row leaves the list, focus goes to the heading once the list is back.
  useEffect(() => {
    if (!headingFocusPending || loading || view !== "list") {
      return;
    }
    listHeadingRef.current?.focus();
    setHeadingFocusPending(false);
  }, [headingFocusPending, loading, view]);

  // After a refused or failed status change or restore, focus goes to the alert.
  useEffect(() => {
    if (!alertFocusPending || listAlert === null || view !== "list") {
      return;
    }
    listAlertRef.current?.focus();
    setAlertFocusPending(false);
  }, [alertFocusPending, listAlert, view]);

  // Losing the key or write access to delete closes an open Delete dialog.
  useEffect(() => {
    if (!canDeleteFamily) {
      familyDelete.close();
    }
  }, [canDeleteFamily]);

  const fetchHouseholds = useCallback(
    async (
      communitySlug: string,
      statusVal: StatusFilter,
      cursorToken: string | undefined,
      isCurrent: () => boolean,
    ) => {
      setLoading(true);
      setError(false);

      const body: Record<string, unknown> = {
        communitySlug,
        limit: 25,
      };
      if (statusVal !== "") {
        body.status = statusVal;
      }
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
        const parsed = parseListResponse(data, statusVal === "deleted");
        if (parsed === null) {
          setLoading(false);
          setError(true);
          return;
        }
        setItems(parsed.items);
        setItemsDeleted(statusVal === "deleted");
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

  // A quiet read replaces the family on screen when it answers and leaves what is shown alone
  // meanwhile, so the page does not blink when a View finds that the family has changed. It speaks
  // up only when the family is gone.
  const fetchDetail = useCallback(
    async (communitySlug: string, householdId: string, isCurrent: () => boolean, quiet = false) => {
      if (!quiet) {
        setDetailLoading(true);
        setDetailNotFound(false);
        setDetailError(false);
      }

      const response = await post("/v1/households/read", {
        communitySlug,
        householdId,
      });
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable") {
        detailAnswers.current += 1;
        setDetailLoading(false);
        setDetailError(!quiet);
        return;
      }
      if (response.status === 404) {
        detailAnswers.current += 1;
        setDetailLoading(false);
        setDetailNotFound(true);
        return;
      }
      if (response.status !== 200) {
        detailAnswers.current += 1;
        setDetailLoading(false);
        setDetailError(!quiet);
        return;
      }
      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parseHouseholdDetail(data);
        if (parsed === null) {
          detailAnswers.current += 1;
          setDetailLoading(false);
          setDetailError(!quiet);
          return;
        }
        setDetailHousehold(parsed);
        detailAnswers.current += 1;
        setDetailLoading(false);
      } catch {
        if (!isCurrent()) {
          return;
        }
        detailAnswers.current += 1;
        setDetailLoading(false);
        setDetailError(!quiet);
      }
    },
    [],
  );

  useEffect(() => {
    detailGeneration.current += 1;
    panelGeneration.current += 1;
    emergency.reset();
    setItems(null);
    setView("list");
    setSelectedHouseholdId(null);
    setDetailHousehold(null);
    setItemsDeleted(false);
    setListAlert(null);
    setHeadingFocusPending(false);
    setAlertFocusPending(false);
    familyActions.reset();
    familyDelete.reset();
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
    setNewAdultForm(initialFormData);
    setNewAdultNotice(null);
    setNewAdultNotFound(false);
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
    void fetchHouseholds(slug, statusFilter, cursor, () => generation.current === mine);
  }, [token, access, slug, version, statusFilter, cursor, fetchHouseholds]);

  function openDetail(householdId: string) {
    setListAlert(null);
    setSelectedHouseholdId(householdId);
    setView("detail");
    setDetailHousehold(null);
    setUnlinkingLinkId(null);
    setUnlinkNotice(null);
    panelGeneration.current += 1;
    emergency.reset();
    const mine = ++detailGeneration.current;
    if (slug) {
      void fetchDetail(slug, householdId, () => detailGeneration.current === mine);
    }
  }

  function reloadDetail(options?: { quiet?: boolean }) {
    if (slug && selectedHouseholdId) {
      const mine = ++detailGeneration.current;
      void fetchDetail(
        slug,
        selectedHouseholdId,
        () => detailGeneration.current === mine,
        options?.quiet === true,
      );
    }
  }

  function backToList() {
    panelGeneration.current += 1;
    emergency.reset();
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
    const query = latestQuery.current;
    if (query.slug) {
      const mine = ++generation.current;
      void fetchHouseholds(
        query.slug,
        query.statusFilter,
        query.cursor,
        () => generation.current === mine,
      );
    }
  }

  function handleNextPage(token: string) {
    setListQuery({ slug, status: statusFilter, cursor: token });
  }

  function changeStatusFilter(next: StatusFilter) {
    if (next === statusFilter) {
      return;
    }
    setItems(null);
    setNextCursor(null);
    setListAlert(null);
    setListQuery({ slug, status: next, cursor: undefined });
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

  function resetNewAdultForm() {
    setNewAdultForm(initialFormData);
    setNewAdultNotice(null);
    setNewAdultNotFound(false);
  }

  function openNewAdult() {
    resetNewAdultForm();
    setView("add-adult-new");
  }

  function cancelNewAdult() {
    resetNewAdultForm();
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
    setLinkChildId(detailHousehold?.minors?.children?.[0]?.personId ?? "");
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

      if (response.status === 422) {
        setCreateNotice(
          (await readErrorCode(response)) === "label_contains_child_name"
            ? LABEL_REFUSED
            : "Invalid input",
        );
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

  async function handleNewAdultSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || submitting || !slug || !detailHousehold || !canAddAdult) {
      return;
    }
    const givenName = newAdultForm.givenName.trim();
    const familyName = newAdultForm.familyName.trim();
    const email = newAdultForm.email.trim();
    const phone = newAdultForm.phone.trim();
    const dateOfBirth = newAdultForm.dateOfBirth.trim();

    setNewAdultNotFound(false);
    if (dateOfBirth !== "" && isUnder18OnSydneyDate(dateOfBirth, new Date())) {
      setNewAdultNotice("This person is under 18. Use Add minor instead.");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setNewAdultNotice(null);
    setNewAdultNotFound(false);
    const mine = panelGeneration.current;

    try {
      const response = await post("/v1/households/members/add-adult", {
        communitySlug: slug,
        householdId: detailHousehold.householdId,
        givenName,
        familyName,
        ...(email !== "" ? { email } : {}),
        ...(phone !== "" ? { phone } : {}),
        ...(dateOfBirth !== "" ? { dateOfBirth } : {}),
      });

      if (response === "unavailable") {
        setNewAdultNotice("Unable to add this adult. Try again.");
        return;
      }

      if (response.status === 201) {
        resetNewAdultForm();
        clearAdultSearch();
        setView("detail");
        reloadDetail();
        return;
      }

      if (response.status === 409) {
        const code = await readErrorCode(response);
        if (panelGeneration.current !== mine) {
          return;
        }
        setNewAdultNotice(
          code === "duplicate_deleted"
            ? duplicateDeletedMessage(Boolean(access.permissions["people.delete"]))
            : "A contact with this email or phone already exists. Search for them instead.",
        );
        return;
      }

      if (response.status === 400) {
        setNewAdultNotice("Check the details and try again.");
        return;
      }

      if (response.status === 404) {
        setNewAdultNotFound(true);
        setNewAdultNotice("Household not found");
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        resetNewAdultForm();
        clearAdultSearch();
        setAdultSearchNotice("Read-only until billing is settled");
        setView("add-adult");
        return;
      }

      setNewAdultNotice("Unable to add this adult. Try again.");
    } finally {
      submittingRef.current = false;
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

      if (response.status === 422) {
        setRenameNotice(
          (await readErrorCode(response)) === "label_contains_child_name"
            ? LABEL_REFUSED
            : "Invalid input",
        );
        return;
      }

      if (response.status === 404) {
        setRenameNotice("Household not found");
        return;
      }

      if (response.status === 200) {
        // The answer's version counts for the emergency contacts only when it is the next one.
        try {
          const answer: unknown = await response.json();
          if (isRecord(answer) && typeof answer.version === "number") {
            emergency.noteVersion(detailHousehold.householdId, answer.version);
          }
        } catch {
          // No version in the answer: the contacts keep the version of the list on screen.
        }
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

      if (response.status === 422) {
        setAddMinorNotice(
          (await readErrorCode(response)) === "label_contains_child_name"
            ? LABEL_REFUSED_FOR_NEW_CHILD
            : "Invalid input",
        );
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
        <Panel
          title="Create Household"
          level={2}
          headingRef={createHeadingRef}
          headingTabIndex={-1}
        >
          {createNotice ? (
            <Alert ref={createAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{createNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleCreateSubmit} className="grid gap-4">
            <Field label="Household name (optional)" help={LABEL_GUIDANCE}>
              <Input
                id="create-household-label"
                value={createLabel}
                onChange={(e) => setCreateLabel(e.target.value)}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save household
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

  if (view === "rename") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel
          title="Rename Household"
          level={2}
          headingRef={renameHeadingRef}
          headingTabIndex={-1}
        >
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

          <form onSubmit={handleRenameSubmit} className="grid gap-4">
            <Field label="Household name" help={LABEL_GUIDANCE}>
              <Input
                id="rename-household-label"
                value={renameLabel}
                onChange={(e) => setRenameLabel(e.target.value)}
              />
            </Field>

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

  const adultSearchColumns: DataTableColumn<AdultSearchItem>[] = [
    {
      key: "givenName",
      header: "Given name",
      primary: true,
      render: (adult) => adult.givenName,
    },
    {
      key: "familyName",
      header: "Family name",
      render: (adult) => adult.familyName,
    },
    {
      key: "actions",
      header: "Actions",
      render: (adult) => (
        <Button
          type="button"
          size="sm"
          disabled={submitting}
          aria-label={`Add ${adult.givenName} ${adult.familyName} to household`}
          onClick={() => void handleAddAdultToHousehold(adult)}
        >
          Add to household
        </Button>
      ),
    },
  ];

  if (view === "add-adult" || (view === "add-adult-new" && !canAddAdult)) {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel title="Add Adult" level={2} headingRef={addAdultHeadingRef} headingTabIndex={-1}>
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

          {canAddAdult ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={openNewAdult}>
                Create new adult
              </Button>
            </div>
          ) : null}

          <FilterBar
            label="Search adults"
            inputId="add-adult-search"
            value={adultSearchDraft}
            onValueChange={setAdultSearchDraft}
            onSubmit={handleAdultSearch}
            submitDisabled={adultSearchLoading}
          />

          <div className="flex flex-wrap gap-2">
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

          {adultSearchLoading ? (
            <>
              <Skeleton />
              <span className="sr-only">Searching...</span>
            </>
          ) : null}

          {adultSearchResults !== null && adultSearchResults.length === 0 ? (
            <EmptyState message="No adults found" />
          ) : null}

          {adultSearchResults !== null && adultSearchResults.length > 0 ? (
            <>
              <DataTable
                aria-label="Adult search results"
                rowKey={(adult) => adult.personId}
                columns={adultSearchColumns}
                rows={adultSearchResults}
              />
              {adultSearchNextCursor !== null ? (
                <p>More results exist. Refine your search.</p>
              ) : null}
            </>
          ) : null}
        </Panel>
      </>
    );
  }

  if (view === "add-adult-new") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel
          title="New adult in this household"
          level={2}
          headingRef={newAdultHeadingRef}
          headingTabIndex={-1}
        >
          {newAdultNotice ? (
            <Alert ref={newAdultAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{newAdultNotice}</span>
              {newAdultNotFound ? (
                <Button type="button" onClick={backToList}>
                  Back to list
                </Button>
              ) : null}
            </Alert>
          ) : null}

          <form onSubmit={handleNewAdultSubmit} className="grid gap-4">
            <ContactFields
              prefix="add-adult"
              data={newAdultForm}
              onChange={setNewAdultForm}
              dobHelp="Under 18? Use Add minor instead."
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save adult
              </Button>
              <Button type="button" variant="outline" onClick={cancelNewAdult}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      </>
    );
  }

  if (view === "move-adult") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel title="Move Adult" level={2} headingRef={moveAdultHeadingRef} headingTabIndex={-1}>
          {moveConflict ? (
            <Alert ref={moveAlertRef} tabIndex={-1} role="alert">
              <span>
                This change could not be applied. The adult may have guardian links, or the
                household changed. Reload to see the latest.
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

          <form onSubmit={handleMoveAdultSubmit} className="grid gap-4">
            <Field label="Target household">
              <Select
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
              </Select>
            </Field>

            <p id="move-adult-target-hint" className="text-sm text-muted-foreground">
              Select a target household, or choose &quot;No household&quot; to remove from
              household.
            </p>
            {nextCursor !== null ? (
              <p id="move-adult-paged-notice" className="text-sm text-muted-foreground">
                The household list is paged. Only currently loaded households are offered.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
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
        </Panel>
      </>
    );
  }

  if (view === "add-minor") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel title="Add Minor" level={2} headingRef={addMinorHeadingRef} headingTabIndex={-1}>
          {addMinorNotice ? (
            <Alert ref={addMinorAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{addMinorNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleAddMinorSubmit} className="grid gap-4">
            <Field label="Given name">
              <Input
                id="minor-given-name"
                value={minorGivenName}
                onChange={(e) => setMinorGivenName(e.target.value)}
                required
              />
            </Field>

            <Field label="Family name">
              <Input
                id="minor-family-name"
                value={minorFamilyName}
                onChange={(e) => setMinorFamilyName(e.target.value)}
                required
              />
            </Field>

            <Field label="Date of birth">
              <Input
                id="minor-dob"
                type="date"
                value={minorDob}
                onChange={(e) => setMinorDob(e.target.value)}
                required
              />
            </Field>

            <Field label="Guardian">
              <Select
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
              </Select>
            </Field>

            <fieldset className="grid gap-2">
              <legend>Guardian rights</legend>
              <Checkbox
                label="Consent"
                checked={minorRights.consent}
                onChange={(e) => setMinorRights((r) => ({ ...r, consent: e.target.checked }))}
              />
              <Checkbox
                label="Pickup"
                checked={minorRights.pickup}
                onChange={(e) => setMinorRights((r) => ({ ...r, pickup: e.target.checked }))}
              />
              <Checkbox
                label="View"
                checked={minorRights.view}
                onChange={(e) => setMinorRights((r) => ({ ...r, view: e.target.checked }))}
              />
              <Checkbox
                label="Manage"
                checked={minorRights.manage}
                onChange={(e) => setMinorRights((r) => ({ ...r, manage: e.target.checked }))}
              />
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save minor
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

  if (view === "link-guardian") {
    return (
      <>
        <ScreenTitle>Family Records</ScreenTitle>
        <Panel
          title="Link Guardian"
          level={2}
          headingRef={linkGuardianHeadingRef}
          headingTabIndex={-1}
        >
          {linkNotice ? (
            <Alert ref={linkAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{linkNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleLinkGuardianSubmit} className="grid gap-4">
            <Field label="Guardian">
              <Select
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
              </Select>
            </Field>

            <Field label="Child">
              <Select
                id="link-guardian-child"
                value={linkChildId}
                onChange={(e) => setLinkChildId(e.target.value)}
                required
              >
                <option value="">Select child</option>
                {detailHousehold?.minors?.children?.map((child) => (
                  <option key={child.personId} value={child.personId}>
                    {child.label}
                  </option>
                ))}
              </Select>
            </Field>

            <fieldset className="grid gap-2">
              <legend>Guardian rights</legend>
              <Checkbox
                label="Consent"
                checked={linkRights.consent}
                onChange={(e) => setLinkRights((r) => ({ ...r, consent: e.target.checked }))}
              />
              <Checkbox
                label="Pickup"
                checked={linkRights.pickup}
                onChange={(e) => setLinkRights((r) => ({ ...r, pickup: e.target.checked }))}
              />
              <Checkbox
                label="View"
                checked={linkRights.view}
                onChange={(e) => setLinkRights((r) => ({ ...r, view: e.target.checked }))}
              />
              <Checkbox
                label="Manage"
                checked={linkRights.manage}
                onChange={(e) => setLinkRights((r) => ({ ...r, manage: e.target.checked }))}
              />
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save link
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
                size="sm"
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
              {canDeleteFamily && detailHousehold ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={(event) =>
                    familyDelete.openDialog(
                      {
                        householdId: detailHousehold.householdId,
                        version: detailHousehold.version,
                        label: detailHousehold.label,
                      },
                      event.currentTarget,
                    )
                  }
                >
                  Delete family
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
              <Button type="button" onClick={() => reloadDetail()}>
                Retry
              </Button>
            </Alert>
          ) : null}

          {!detailLoading && !detailNotFound && !detailError && detailHousehold?.label ? (
            <p>
              <strong>Household name:</strong> {detailHousehold.label}
            </p>
          ) : null}

          {!detailLoading && !detailNotFound && !detailError && detailHousehold ? (
            <p>
              <strong>Status:</strong>{" "}
              <StatusBadge tone={detailHousehold.status === "inactive" ? "neutral" : "success"}>
                {detailHousehold.status === "inactive" ? "Inactive" : "Active"}
              </StatusBadge>
            </p>
          ) : null}
        </Panel>
        {familyDelete.dialog}

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

            {detailHousehold.minors ? (
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
                onStale={(reason) => {
                  if (reason === "not_allowed") {
                    setUnlinkNotice("Not allowed");
                  }
                  reloadDetail({ quiet: true });
                }}
              />
            ) : null}

            {emergency.panel}
          </>
        ) : null}
      </>
    );
  }

  const rows = items !== null && itemsDeleted === deletedView ? items : null;
  const listColumns: DataTableColumn<HouseholdItem>[] = [
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
    statusColumn({
      canSwitch: canManage && !hideWrites,
      pending: familyActions.pending,
      onToggle: (household) => void familyActions.toggleStatus(household),
    }),
    {
      key: "actions",
      header: "Actions",
      render: (household) => (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`View ${household.label ?? "household"}`}
          onClick={() => openDetail(household.householdId)}
        >
          View
        </Button>
      ),
    },
  ];

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

      {listAlert ? (
        <Alert ref={listAlertRef} tabIndex={-1} variant="destructive" role="alert">
          <span>{listAlert}</span>
        </Alert>
      ) : null}

      {canCreate ? (
        <div>
          <Button type="button" onClick={openCreate}>
            Create household
          </Button>
        </div>
      ) : null}

      <StatusFilterSelect
        value={statusFilter}
        onChange={changeStatusFilter}
        canFilterDeleted={canFilterDeleted}
      />

      {loading && rows === null ? (
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

      {!error && rows !== null ? (
        rows.length === 0 ? (
          <EmptyState
            message={
              deletedView
                ? "No deleted families."
                : statusFilter !== ""
                  ? "No households match this filter"
                  : "No households yet"
            }
          />
        ) : (
          <>
            <DataTable
              aria-label="Households"
              rowKey={(household) => household.householdId}
              columns={
                deletedView
                  ? deletedColumns({
                      canRestore: canDeleteFamily,
                      restoringId: familyActions.restoringId,
                      onRestore: (household) => void familyActions.restore(household),
                    })
                  : listColumns
              }
              rows={rows}
            />

            <Pagination cursor={nextCursor} onNext={handleNextPage} />
          </>
        )
      ) : null}
    </>
  );
}
