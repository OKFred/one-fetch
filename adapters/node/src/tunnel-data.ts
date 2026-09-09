import type WebSocket from "ws";

export const tunnelDataToBuffer = (data: WebSocket.RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError("Unsupported WebSocket data representation");
};

export const tunnelDataToText = (data: WebSocket.RawData): string =>
  tunnelDataToBuffer(data).toString("utf8");
