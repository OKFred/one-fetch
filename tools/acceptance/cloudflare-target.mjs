import { handleConformanceTarget } from "../../packages/conformance/dist/index.js";

export default {
  fetch(request) {
    return handleConformanceTarget(request);
  },
};
