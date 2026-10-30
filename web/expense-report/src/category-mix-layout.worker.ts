import { refineContourScene, type ContourScene } from "./category-mix-layout"

self.onmessage = (event: MessageEvent<ContourScene>) => {
  try { self.postMessage({ scene: refineContourScene(event.data) }) }
  catch { self.postMessage({ scene: null }) }
}
