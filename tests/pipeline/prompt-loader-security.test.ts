import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt } from "../../src/pipeline/prompt-loader";
import type { PipelineStage } from "../../src/pipeline/prompt-loader";

describe("prompt loader security", () => {
  describe("path traversal prevention", () => {
    it("should reject directory traversal in stage", () => {
      assert.throws(
        () => {
          loadPrompt("../docs" as PipelineStage, "v1");
        },
        {
          message: /Invalid stage/,
        },
        "Should reject stage with ../"
      );
    });

    it("should reject directory traversal in version", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "../../../etc/passwd");
        },
        {
          message: /Invalid version format/,
        },
        "Should reject version with ../"
      );
    });

    it("should reject absolute paths in stage", () => {
      assert.throws(
        () => {
          loadPrompt("/etc/passwd" as PipelineStage, "v1");
        },
        {
          message: /Invalid stage/,
        },
        "Should reject absolute path in stage"
      );
    });

    it("should reject absolute paths in version", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "/etc/passwd");
        },
        {
          message: /Invalid version format/,
        },
        "Should reject absolute path in version"
      );
    });

    it("should reject URL-encoded traversal in version", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "..%2F..%2Fetc%2Fpasswd");
        },
        {
          message: /Invalid version format/,
        },
        "Should reject URL-encoded ../"
      );
    });

    it("should reject invalid stage names", () => {
      assert.throws(
        () => {
          loadPrompt("bogus_stage" as PipelineStage, "v1");
        },
        {
          message: /Invalid stage/,
        },
        "Should reject unknown stage"
      );
    });

    it("should reject version without v prefix", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "1");
        },
        {
          message: /Invalid version format/,
        },
        "Should reject version without 'v' prefix"
      );
    });

    it("should reject version with non-numeric suffix", () => {
      assert.throws(
        () => {
          loadPrompt("parse_intent", "v1.x");
        },
        {
          message: /Invalid version format/,
        },
        "Should reject version with non-numeric characters"
      );
    });

    it("should not leak absolute paths in error messages", () => {
      try {
        loadPrompt("parse_intent", "v999");
        assert.fail("Should have thrown");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          !message.includes(process.cwd()),
          "Error message should not contain absolute workspace path"
        );
        assert.ok(
          !message.includes("/workspace"),
          "Error message should not contain absolute paths"
        );
      }
    });

    it("should accept valid version formats", () => {
      // v1 exists, should load successfully
      assert.doesNotThrow(() => {
        loadPrompt("parse_intent", "v1");
      }, "Should accept v1");

      // v2 doesn't exist, but format is valid so it should fail with file-not-found, not format error
      try {
        loadPrompt("parse_intent", "v2");
        assert.fail("Should throw for non-existent file");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          message.includes("not found") && !message.includes("Invalid version format"),
          "Should fail with file-not-found, not format error"
        );
      }

      // v123 format is valid (even though file doesn't exist)
      try {
        loadPrompt("parse_intent", "v123");
        assert.fail("Should throw for non-existent file");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          message.includes("not found") && !message.includes("Invalid version format"),
          "Should fail with file-not-found, not format error for v123"
        );
      }
    });
  });

  describe("runtime stage validation", () => {
    it("should validate stage at runtime, not just at type level", () => {
      const invalidStage = "not_a_stage" as PipelineStage;

      assert.throws(
        () => {
          loadPrompt(invalidStage, "v1");
        },
        {
          message: /Invalid stage/,
        },
        "Should reject invalid stage even when type-casted"
      );
    });
  });
});
