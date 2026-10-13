import { createProductionItineraryViewHandler } from "../../../../src/api/itinerary-view";

const view = createProductionItineraryViewHandler();

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return view(request, id);
}
