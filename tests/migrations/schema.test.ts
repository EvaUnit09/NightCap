import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("Supabase migration schema", () => {
  const migrationPath = join(process.cwd(), "supabase/migrations/20261010170501_init.sql");
  const sql = readFileSync(migrationPath, "utf-8");

  describe("Required tables", () => {
    it("creates requests table", () => {
      assert.ok(sql.includes("CREATE TABLE requests"));
    });

    it("creates itineraries table", () => {
      assert.ok(sql.includes("CREATE TABLE itineraries"));
    });

    it("creates feedback table", () => {
      assert.ok(sql.includes("CREATE TABLE feedback"));
    });

    it("creates places_cache table", () => {
      assert.ok(sql.includes("CREATE TABLE places_cache"));
    });

    it("creates saved_plans table", () => {
      assert.ok(sql.includes("CREATE TABLE saved_plans"));
    });
  });

  describe("requests table schema", () => {
    it("has id column", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("id UUID"));
    });

    it("has created_at column", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("created_at TIMESTAMPTZ"));
    });

    it("has redacted_text column", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("redacted_text TEXT"));
    });

    it("has parsed_intent jsonb column", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("parsed_intent JSONB"));
    });

    it("has client_hash column", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("client_hash TEXT"));
    });
  });

  describe("itineraries table schema", () => {
    it("has id column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("id UUID"));
    });

    it("has request_id foreign key", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("request_id UUID"));
      assert.ok(itinerariesBlock.includes("REFERENCES requests"));
    });

    it("has option_index column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("option_index INTEGER"));
    });

    it("has stops jsonb column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("stops JSONB"));
    });

    it("has valid boolean column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("valid BOOLEAN"));
    });

    it("has validation_errors jsonb column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("validation_errors JSONB"));
    });

    it("has prompt_versions jsonb column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("prompt_versions JSONB"));
    });

    it("has models jsonb column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("models JSONB"));
    });

    it("has cost_usd column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("cost_usd DECIMAL"));
    });

    it("has latency_ms column", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("latency_ms INTEGER"));
    });
  });

  describe("feedback table schema", () => {
    it("has id column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("id UUID"));
    });

    it("has itinerary_id foreign key", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("itinerary_id UUID"));
      assert.ok(feedbackBlock.includes("REFERENCES itineraries"));
    });

    it("has thumbs column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("thumbs SMALLINT"));
    });

    it("has would_go column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("would_go BOOLEAN"));
    });

    it("has did_go column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("did_go BOOLEAN"));
    });

    it("has new_to_you jsonb column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("new_to_you JSONB"));
    });

    it("has closed_report_place_id column", () => {
      const feedbackBlock = extractTableBlock(sql, "feedback");
      assert.ok(feedbackBlock.includes("closed_report_place_id TEXT"));
    });
  });

  describe("places_cache table schema", () => {
    it("has cache_key column", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("cache_key TEXT"));
    });

    it("has place_id column", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("place_id TEXT"));
    });

    it("has lat and lng columns for coordinates", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("lat DECIMAL"));
      assert.ok(cacheBlock.includes("lng DECIMAL"));
    });

    it("has payload jsonb column", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("payload JSONB"));
    });

    it("has fetched_at timestamp", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("fetched_at TIMESTAMPTZ"));
    });

    it("has expires_at timestamp", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("expires_at TIMESTAMPTZ"));
    });

    it("documents Google Places API caching compliance", () => {
      // Check that the migration includes documentation about Google's caching terms
      assert.ok(sql.includes("Google Places API Caching"));
      assert.ok(sql.includes("place_id") && sql.includes("indefinitely"));
      assert.ok(sql.includes("lat") || sql.includes("lng"));
    });
  });

  describe("saved_plans table schema", () => {
    it("has id column", () => {
      const savedPlansBlock = extractTableBlock(sql, "saved_plans");
      assert.ok(savedPlansBlock.includes("id UUID"));
    });

    it("has user_id column", () => {
      const savedPlansBlock = extractTableBlock(sql, "saved_plans");
      assert.ok(savedPlansBlock.includes("user_id UUID"));
    });

    it("has itinerary_id foreign key", () => {
      const savedPlansBlock = extractTableBlock(sql, "saved_plans");
      assert.ok(savedPlansBlock.includes("itinerary_id UUID"));
      assert.ok(savedPlansBlock.includes("REFERENCES itineraries"));
    });

    it("has share_slug column", () => {
      const savedPlansBlock = extractTableBlock(sql, "saved_plans");
      assert.ok(savedPlansBlock.includes("share_slug TEXT"));
    });
  });

  describe("Row Level Security (RLS)", () => {
    it("enables RLS on requests table", () => {
      assert.ok(sql.includes("ALTER TABLE requests ENABLE ROW LEVEL SECURITY"));
    });

    it("enables RLS on itineraries table", () => {
      assert.ok(sql.includes("ALTER TABLE itineraries ENABLE ROW LEVEL SECURITY"));
    });

    it("enables RLS on feedback table", () => {
      assert.ok(sql.includes("ALTER TABLE feedback ENABLE ROW LEVEL SECURITY"));
    });

    it("enables RLS on places_cache table", () => {
      assert.ok(sql.includes("ALTER TABLE places_cache ENABLE ROW LEVEL SECURITY"));
    });

    it("enables RLS on saved_plans table", () => {
      assert.ok(sql.includes("ALTER TABLE saved_plans ENABLE ROW LEVEL SECURITY"));
    });

    it("creates RLS policy for saved_plans user ownership", () => {
      assert.ok(sql.includes("CREATE POLICY") && sql.includes("saved_plans"));
      assert.ok(sql.includes("auth.uid()"));
    });
  });

  describe("Indexes", () => {
    it("creates index on requests.created_at", () => {
      assert.ok(sql.includes("idx_requests_created_at"));
    });

    it("creates index on itineraries.request_id", () => {
      assert.ok(sql.includes("idx_itineraries_request_id"));
    });

    it("creates index on feedback.itinerary_id", () => {
      assert.ok(sql.includes("idx_feedback_itinerary_id"));
    });

    it("creates index on places_cache.cache_key", () => {
      assert.ok(sql.includes("idx_places_cache_cache_key"));
    });

    it("creates index on places_cache.expires_at", () => {
      assert.ok(sql.includes("idx_places_cache_expires_at"));
    });

    it("creates index on saved_plans.user_id", () => {
      assert.ok(sql.includes("idx_saved_plans_user_id"));
    });

    it("creates index on saved_plans.share_slug", () => {
      assert.ok(sql.includes("idx_saved_plans_share_slug"));
    });
  });

  describe("Constraints and validation", () => {
    it("enforces non-empty redacted_text in requests", () => {
      const requestsBlock = extractTableBlock(sql, "requests");
      assert.ok(requestsBlock.includes("CHECK"));
    });

    it("enforces positive option_index in itineraries", () => {
      const itinerariesBlock = extractTableBlock(sql, "itineraries");
      assert.ok(itinerariesBlock.includes("option_index") && itinerariesBlock.includes("CHECK"));
    });

    it("enforces valid expires_at > fetched_at in places_cache", () => {
      const cacheBlock = extractTableBlock(sql, "places_cache");
      assert.ok(cacheBlock.includes("expires_at > fetched_at"));
    });

    it("enforces share_slug format in saved_plans", () => {
      const savedPlansBlock = extractTableBlock(sql, "saved_plans");
      assert.ok(savedPlansBlock.includes("share_slug") && savedPlansBlock.includes("CHECK"));
    });
  });

  describe("Helper functions", () => {
    it("creates cleanup_expired_cache function", () => {
      assert.ok(sql.includes("CREATE OR REPLACE FUNCTION cleanup_expired_cache"));
    });
  });
});

/**
 * Extract a table definition block from SQL for targeted assertions.
 */
function extractTableBlock(sql: string, tableName: string): string {
  const tableStart = sql.indexOf(`CREATE TABLE ${tableName}`);
  if (tableStart === -1) {
    throw new Error(`Table ${tableName} not found in SQL`);
  }
  
  // Find the closing semicolon for this CREATE TABLE statement
  let depth = 0;
  let i = tableStart;
  let tableBlock = "";
  
  while (i < sql.length) {
    const char = sql[i];
    tableBlock += char;
    
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === ";" && depth === 0) {
      break;
    }
    i++;
  }
  
  return tableBlock;
}
