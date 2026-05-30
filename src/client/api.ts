import type { Trip, TripBundle, SettlementStatus } from "../shared/types.ts";

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
  getTrip: (id: number) => req<TripBundle>(`/api/trips/${id}`),
  getTripByUuid: (uuid: string) => req<TripBundle>(`/api/by-uuid/${uuid}`),
  seed: () => req<TripBundle>("/api/seed", { method: "POST" }),

  updateTrip: (id: number, body: Partial<Trip>) =>
    req<TripBundle>(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  addPerson: (
    tripId: number,
    body: { name: string; code?: string; email?: string; type: string; parent_id?: number | null },
  ) => req<TripBundle>(`/api/trips/${tripId}/people`, { method: "POST", body: JSON.stringify(body) }),
  deletePerson: (pid: number) => req<TripBundle>(`/api/people/${pid}`, { method: "DELETE" }),

  addGroup: (tripId: number, body: Record<string, unknown>) =>
    req<TripBundle>(`/api/trips/${tripId}/groups`, { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (gid: number, body: Record<string, unknown>) =>
    req<TripBundle>(`/api/groups/${gid}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGroup: (gid: number) => req<TripBundle>(`/api/groups/${gid}`, { method: "DELETE" }),
  setDrivers: (gid: number, person_ids: number[]) =>
    req<TripBundle>(`/api/groups/${gid}/drivers`, { method: "PUT", body: JSON.stringify({ person_ids }) }),
  setMembers: (gid: number, person_ids: number[]) =>
    req<TripBundle>(`/api/groups/${gid}/members`, { method: "PUT", body: JSON.stringify({ person_ids }) }),

  addExpense: (
    tripId: number,
    body: { group_id: number; description: string; amount: number; payer_id: number },
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
};

export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
