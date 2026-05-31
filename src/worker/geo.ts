// Thin proxy over Google Maps Platform. The API key never reaches the browser:
// the client calls our /api/geo/* endpoints and the Worker injects the key.
//
// Uses:
//   * Places Autocomplete (New)  — address suggestions
//   * Routes API computeRoutes    — most-direct driving distance

const HOME_ORIGIN = "651 El Camino Real, Redwood City, CA";

export interface AutocompleteResult {
  description: string; // full address text used verbatim as the field value
}

export async function autocomplete(key: string, input: string): Promise<AutocompleteResult[]> {
  const q = input.trim();
  if (q.length < 3) return [];
  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
    },
    body: JSON.stringify({
      input: q,
      includedRegionCodes: ["us"],
      // Bias toward the troop's home area (Redwood City, CA). Google caps the
      // bias radius at 50 km; it's only a bias, not a hard filter.
      locationBias: {
        circle: {
          center: { latitude: 37.4845, longitude: -122.2283 },
          radius: 50000,
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`places autocomplete ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    suggestions?: { placePrediction?: { text?: { text?: string } } }[];
  };
  return (data.suggestions ?? [])
    .map((s) => s.placePrediction?.text?.text)
    .filter((t): t is string => !!t)
    .map((description) => ({ description }));
}

const METERS_PER_MILE = 1609.344;

/** One-way driving miles for the most direct route between two addresses. */
export async function drivingMiles(key: string, from: string, to: string): Promise<number> {
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { address: from || HOME_ORIGIN },
      destination: { address: to },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE", // deterministic, no departure time needed
      units: "IMPERIAL",
    }),
  });
  if (!res.ok) {
    throw new Error(`routes computeRoutes ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { routes?: { distanceMeters?: number }[] };
  const meters = data.routes?.[0]?.distanceMeters;
  if (meters == null) throw new Error("no route found between the given addresses");
  return Math.round((meters / METERS_PER_MILE) * 10) / 10; // 0.1 mi precision
}
