import { StartSessionRenewal } from "~/services/SessionRenewal";

export default defineNuxtPlugin(() => {
  StartSessionRenewal();
});
