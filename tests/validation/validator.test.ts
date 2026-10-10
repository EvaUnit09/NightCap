import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Candidate } from "../../src/validation/candidate";
import type { Intent } from "../../src/validation/intent";
import type { Itinerary } from "../../src/validation/itinerary";
import {
  validateItinerary,
  type ValidatorInput,
} from "../../src/validation/validator";
import type { TravelCalculator } from "../../src/validation/travel";

describe("validateItinerary", () => {
  const baseIntent: Intent = {
    area: "Manhattan",
    window: {
      start: "2026-10-15T19:00:00-04:00",
      end: "2026-10-15T23:00:00-04:00",
    },
    budgetUsd: 200,
    dietary: [],
    vibeTags: ["cozy", "craft"],
    stopTypes: ["drinks", "dinner"],
  };

  const baseCandidate: Candidate = {
    placeId: "ChIJ1",
    name: "Test Venue",
    businessStatus: "OPERATIONAL",
    priceLevel: "PRICE_LEVEL_MODERATE",
    rating: 4.5,
    reviewCount: 100,
    location: { lat: 40.7589, lng: -73.9851 },
    openingHours: [
      {
        open: { day: 4, hour: 17, minute: 0 },
        close: { day: 4, hour: 23, minute: 0 },
      },
    ],
    types: ["bar"],
    stopType: "drinks",
  };

  const baseItinerary: Itinerary = {
    options: [
      {
        theme: "Craft cocktails and upscale dining",
        stops: [
          {
            placeId: "ChIJ1",
            name: "Test Venue",
            start: "2026-10-15T19:00:00-04:00",
            end: "2026-10-15T20:00:00-04:00",
            estimatedCostUsd: 80,
            why: "Craft cocktails",
            travelToNext: {
              mode: "walk",
              minutes: 10,
            },
          },
          {
            placeId: "ChIJ2",
            name: "Test Restaurant",
            start: "2026-10-15T20:15:00-04:00",
            end: "2026-10-15T22:00:00-04:00",
            estimatedCostUsd: 100,
            why: "Upscale dining",
            travelToNext: null,
          },
        ],
      },
    ],
  };

  const mockTravelCalculator: TravelCalculator = {
    calculateMinutes: () => 10,
  };

  it("should pass validation for a valid itinerary", async () => {
    const candidates: Candidate[] = [
      baseCandidate,
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 0, `Expected no validation errors, got: ${JSON.stringify(errors, null, 2)}`);
  });

  it("should detect invented venues", async () => {
    const candidates: Candidate[] = [baseCandidate];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "invented_venue");
    assert.equal(errors[0]?.placeId, "ChIJ2");
    assert.equal(errors[0]?.optionIndex, 0);
    assert.equal(errors[0]?.stopIndex, 1);
  });

  it("should detect non-operational venues", async () => {
    const candidates: Candidate[] = [
      { ...baseCandidate, businessStatus: "CLOSED_PERMANENTLY" },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "not_operational");
    assert.equal(errors[0]?.optionIndex, 0);
    assert.equal(errors[0]?.stopIndex, 0);
  });

  it("should detect closed venues", async () => {
    const candidates: Candidate[] = [
      {
        ...baseCandidate,
        openingHours: [
          {
            open: { day: 4, hour: 12, minute: 0 },
            close: { day: 4, hour: 17, minute: 0 },
          },
        ],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "closed");
    assert.equal(errors[0]?.optionIndex, 0);
    assert.equal(errors[0]?.stopIndex, 0);
  });

  it("should detect over-budget itineraries", async () => {
    const candidates: Candidate[] = [
      baseCandidate,
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: { ...baseIntent, budgetUsd: 150 },
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "over_budget");
    assert.equal(errors[0]?.optionIndex, 0);
    assert.ok(
      errors[0]?.message.includes("$180 exceeds budget $150")
    );
  });

  it("should detect travel time exceeding cap", async () => {
    const candidates: Candidate[] = [
      baseCandidate,
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const longTravelCalculator: TravelCalculator = {
      calculateMinutes: () => 30,
    };

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, longTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "travel_too_long");
    assert.equal(errors[0]?.optionIndex, 0);
    assert.equal(errors[0]?.stopIndex, 0);
    assert.ok(errors[0]?.message.includes("30 min"));
  });

  it("should handle 24/7 venues", async () => {
    const candidates: Candidate[] = [
      {
        ...baseCandidate,
        openingHours: [
          {
            open: { day: 0, hour: 0, minute: 0 },
          },
        ],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors, null, 2)}`);
  });

  it("should detect FUTURE_OPENING venues as not operational", async () => {
    const candidates: Candidate[] = [
      {
        ...baseCandidate,
        businessStatus: "FUTURE_OPENING",
        openingHours: [],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "not_operational");
  });

  it("should handle PRICE_LEVEL_UNSPECIFIED", async () => {
    const candidates: Candidate[] = [
      { ...baseCandidate, priceLevel: "PRICE_LEVEL_UNSPECIFIED" },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors, null, 2)}`);
  });

  it("should handle slots crossing midnight", async () => {
    const candidates: Candidate[] = [
      {
        ...baseCandidate,
        openingHours: [
          {
            open: { day: 4, hour: 22, minute: 0 },
            close: { day: 5, hour: 2, minute: 0 },
          },
        ],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 22, minute: 0 },
            close: { day: 5, hour: 2, minute: 0 },
          },
        ],
      },
    ];

    const lateItinerary: Itinerary = {
      options: [
        {
          theme: "Late night",
          stops: [
            {
              placeId: "ChIJ1",
              name: "Test Venue",
              start: "2026-10-15T23:00:00-04:00",
              end: "2026-10-16T00:30:00-04:00",
              estimatedCostUsd: 80,
              why: "Late night drinks",
              travelToNext: {
                mode: "walk",
                minutes: 10,
              },
            },
            {
              placeId: "ChIJ2",
              name: "Test Restaurant",
              start: "2026-10-16T00:45:00-04:00",
              end: "2026-10-16T02:00:00-04:00",
              estimatedCostUsd: 60,
              why: "Late night food",
              travelToNext: null,
            },
          ],
        },
      ],
    };

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: lateItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors, null, 2)}`);
  });

  it("should validate multiple options independently", async () => {
    const candidates: Candidate[] = [
      baseCandidate,
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ3",
        name: "Another Bar",
        location: { lat: 40.7610, lng: -73.9870 },
        stopType: "drinks",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const multiOptionItinerary: Itinerary = {
      options: [
        baseItinerary.options[0]!,
        {
          theme: "Option 2 with bad venue",
          stops: [
            {
              placeId: "ChIJ3",
              name: "Another Bar",
              start: "2026-10-15T19:00:00-04:00",
              end: "2026-10-15T20:00:00-04:00",
              estimatedCostUsd: 250,
              why: "Expensive drinks",
              travelToNext: null,
            },
          ],
        },
      ],
    };

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: multiOptionItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "over_budget");
    assert.equal(errors[0]?.optionIndex, 1);
  });

  it("should handle null travel time gracefully", async () => {
    const candidates: Candidate[] = [
      baseCandidate,
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const nullTravelCalculator: TravelCalculator = {
      calculateMinutes: () => null,
    };

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, nullTravelCalculator);
    assert.equal(errors.length, 0, `Expected no errors, got: ${JSON.stringify(errors, null, 2)}`);
  });

  it("should handle venues with no opening hours as closed", async () => {
    const candidates: Candidate[] = [
      {
        ...baseCandidate,
        openingHours: [],
      },
      {
        ...baseCandidate,
        placeId: "ChIJ2",
        name: "Test Restaurant",
        location: { lat: 40.7600, lng: -73.9860 },
        stopType: "dinner",
        openingHours: [
          {
            open: { day: 4, hour: 17, minute: 0 },
            close: { day: 4, hour: 23, minute: 0 },
          },
        ],
      },
    ];

    const input: ValidatorInput = {
      intent: baseIntent,
      candidates,
      itinerary: baseItinerary,
    };

    const errors = await validateItinerary(input, mockTravelCalculator);
    assert.equal(errors.length, 1, `Expected 1 error, got: ${JSON.stringify(errors, null, 2)}`);
    assert.equal(errors[0]?.code, "closed");
  });
});
