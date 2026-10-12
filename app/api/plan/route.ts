import { createPlanHandler } from "../../../src/api/plan-stream";
import { createPipelineDeps } from "../../../src/pipeline";

export const POST = createPlanHandler(() => createPipelineDeps());
