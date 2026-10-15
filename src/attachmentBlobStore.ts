import { MeshBlobStore } from "@meta-uber/mesh-blob"
import { BrowserMeshStore } from "@meta-uber/mesh-browser-store"

export const attachmentBlobStore = new MeshBlobStore(new BrowserMeshStore("tincanban-attachments-v1", ["blobs"]))
