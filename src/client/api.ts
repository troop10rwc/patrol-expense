import type { Trip, TripBundle, TripSummary, SettlementStatus, RosterMember } from "../shared/types.ts";
export { HOME_ADDRESS } from "../shared/constants.ts";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
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
