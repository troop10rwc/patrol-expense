import type { Trip, TripBundle, TripSummary, SettlementStatus, RosterMember, SnapshotMeta, Snapshot, ImportPreview, PersonStatement } from "../shared/types.ts";
import type { BundleDiff } from "../shared/diff.ts";
import { BASE_PATH } from "../shared/constants.ts";
export { HOME_ADDRESS } from "../shared/constants.ts";

/** Thrown when an API call returns 401 — the caller should send the member to
 *  sign in. Carries the identity service origin when the Worker provided it. */
export class UnauthorizedError extends Error {
  constructor(public authOrigin?: string) { super("unauthorized"); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_PATH}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new UnauthorizedError((body as { authOrigin?: string }).authOrigin);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Me {
  email: string;
  name: string;
  // Origin of the shared identity service (e.g. https://id.troop10rwc.org),
  // used to build the sign-in / sign-out links.
  authOrigin: string;
}

// Sign-in / sign-out live at the shared identity service (id.troop10rwc.org).
// Both carry a redirect back into this app once the ceremony completes.
export const loginUrl = (authOrigin: string) =>
  `${authOrigin}/login?redirect=${encodeURIComponent(location.href)}`;
export const logoutUrl = (authOrigin: string) =>
  `${authOrigin}/logout?redirect=${encodeURIComponent(location.origin + BASE_PATH)}`;

export const api = {
  me: () => req<Me>("/api/me"),
  myStatement: () => req<PersonStatement>("/api/me/statement"),
  listTrips: () => req<Trip[]>("/api/trips"),
  getSummary: () => req<TripSummary[]>("/api/summary"),
  getTrip: (id: number) => req<TripBundle>(`/api/trips/${id}`),
  getTripByUuid: (uuid: string) => req<TripBundle>(`/api/by-uuid/${uuid}`),
  getRoster: (tripId: number) => req<RosterMember[]>(`/api/trips/${tripId}/roster`),
  seed: () => req<TripBundle>("/api/seed", { method: "POST" }),

  createTrip: (body: { name: string; trip_date?: string | null; slack_url?: string | null }) =>
    req<TripBundle>("/api/trips", { method: "POST", body: JSON.stringify(body) }),

  updateTrip: (id: number, body: Partial<Trip>) =>
    req<TripBundle>(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  addPerson: (
    tripId: number,
    body: { name: string; code?: string; email?: string; type: string; parent_id?: number | null; parent_ref?: string },
  ) => req<TripBundle>(`/api/trips/${tripId}/people`, { method: "POST", body: JSON.stringify(body) }),
  deletePerson: (pid: number) => req<TripBundle>(`/api/people/${pid}`, { method: "DELETE" }),

  addGroup: (tripId: number, body: Record<string, unknown>) =>
    req<TripBundle>(`/api/trips/${tripId}/groups`, { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (gid: number, body: Record<string, unknown>) =>
    req<TripBundle>(`/api/groups/${gid}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGroup: (gid: number) => req<TripBundle>(`/api/groups/${gid}`, { method: "DELETE" }),
  // refs are "id:<localId>" or "bsa:<bsaNumber>"; roster members are projected
  // into the local people table server-side.
  setDrivers: (gid: number, refs: string[]) =>
    req<TripBundle>(`/api/groups/${gid}/drivers`, { method: "PUT", body: JSON.stringify({ refs }) }),
  setMembers: (gid: number, refs: string[]) =>
    req<TripBundle>(`/api/groups/${gid}/members`, { method: "PUT", body: JSON.stringify({ refs }) }),

  addExpense: (
    tripId: number,
    body: { group_id: number; description: string; amount: number; payer_ref: string },
  ) => req<TripBundle>(`/api/trips/${tripId}/expenses`, { method: "POST", body: JSON.stringify(body) }),
  deleteExpense: (eid: number) => req<TripBundle>(`/api/expenses/${eid}`, { method: "DELETE" }),

  addPrepayment: (tripId: number, body: { person_id: number; amount: number; note?: string }) =>
    req<TripBundle>(`/api/trips/${tripId}/prepayments`, { method: "POST", body: JSON.stringify(body) }),
  deletePrepayment: (id: number) => req<TripBundle>(`/api/prepayments/${id}`, { method: "DELETE" }),

  setStatus: (tripId: number, pid: number, status: SettlementStatus) =>
    req<TripBundle>(`/api/trips/${tripId}/settlements/${pid}`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),

  // ---- snapshots ----
  takeSnapshot: (tripId: number, label?: string) =>
    req<SnapshotMeta>(`/api/trips/${tripId}/snapshots`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  listSnapshots: (tripId: number) => req<SnapshotMeta[]>(`/api/trips/${tripId}/snapshots`),
  getSnapshot: (sid: number) => req<Snapshot>(`/api/snapshots/${sid}`),
  deleteSnapshot: (sid: number) => req<{ ok: true }>(`/api/snapshots/${sid}`, { method: "DELETE" }),
  getChanges: (tripId: number) =>
    req<{ since: SnapshotMeta | null; diff: BundleDiff | null }>(`/api/trips/${tripId}/changes`),

  // ---- Google Sheet import (preview -> commit) ----
  importPreview: (sheetUrl: string) =>
    req<ImportPreview>("/api/import/preview", { method: "POST", body: JSON.stringify({ sheetUrl }) }),
  importCommit: (preview: ImportPreview) =>
    req<{ tripId: number; snapshotId: number; bundle: TripBundle }>("/api/import/commit", {
      method: "POST",
      body: JSON.stringify({ preview }),
    }),

  geoAutocomplete: (q: string) =>
    req<{ description: string }[]>(`/api/geo/autocomplete?q=${encodeURIComponent(q)}`),
  geoDistance: (from: string, to: string) =>
    req<{ one_way_miles: number; round_trip_miles: number }>(
      `/api/geo/distance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
};


export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
