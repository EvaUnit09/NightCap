import { createProductionSharedPlanHandler } from "../../../../src/api/share";

const read = createProductionSharedPlanHandler();

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  return read(slug);
}
