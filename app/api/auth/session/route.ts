import { connection } from "next/server";

import { createProductionSessionHandler } from "../../../../src/auth/magic-link";

const read = createProductionSessionHandler();

export async function GET(request: Request): Promise<Response> {
  await connection();
  return read(request);
}
