import { Inngest } from "inngest";

const isDev =
  process.env.INNGEST_DEV === "1" ||
  process.env.INNGEST_DEV === "true" ||
  process.env.NODE_ENV === "development";

export const inngest = new Inngest({
  id: "adloom",
  name: "Adloom",
  isDev,
});
