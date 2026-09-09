import { handleConformanceTarget } from "@one-fetch/conformance";

export default {
  fetch(request) {
    return handleConformanceTarget(request);
  },
};
