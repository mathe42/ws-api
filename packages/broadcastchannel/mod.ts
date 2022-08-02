import type { DefClient, Definition } from "@ws-api/core";
import { ClientRequest } from "@ws-api/core";

export function setupMaster<DEF extends Definition>(
  client: DefClient<DEF>,
  prefix = "@ws-api",
) {
  const mainChannel = new BroadcastChannel(prefix);

  mainChannel.addEventListener("message", (ev: MessageEvent<string>) => {
    const newChannel = new BroadcastChannel(prefix + "/" + ev.data);

    const idMap = new Map<
      number,
      { req: ClientRequest<any>; kill: () => void }
    >();

    newChannel.addEventListener(
      "message",
      async (
        ev: MessageEvent<
        {action: "killAll"} |
          { id: number; action: "kill" } | {
            id: number;
            action: "get" | "set";
            name: string;
            args: any[];
          }
        >,
      ) => {
        if (ev.data.action === "set") {
          const res = await client[ev.data.action][ev.data.name](
            ...ev.data.args as unknown as any,
          );

          newChannel.postMessage({ id: ev.data.id, return: res });
        }

        if (ev.data.action === "get") {
          const res = client[ev.data.action][ev.data.name](
            ...ev.data.args as unknown as any,
          );

          const fnSub = (v: any) => {
            newChannel.postMessage({ id: (ev.data as any).id, return: v });
          }

          res.subscribe(fnSub);

          if (res.value) fnSub(res.value);

          idMap.set(ev.data.id, {
            req: res,
            kill: () => {
              res.unsubscribe(fnSub);
              res.kill();
            },
          });
        }

        if (ev.data.action === "kill") {
          const el = idMap.get(ev.data.id);

          el?.kill();
        }

        if(ev.data.action === "killAll") {
          newChannel.close()
          idMap.forEach(el => el.kill())
        }
      },
    );
  });
}

export function setupClient<DEF extends Definition>(
  name = Math.random().toString(),
  prefix = "@ws-api",
): DefClient<DEF> {
  const mainChannel = new BroadcastChannel(prefix);

  mainChannel.postMessage(name);

  const clientChannel = new BroadcastChannel(prefix + "/" + name);

  let idCounter = 0;

  const requests = new Map<number, ClientRequest<any>>();

  clientChannel.addEventListener(
    "message",
    (ev: MessageEvent<{ id: number; return: any }>) => {
      if (requests.has(ev.data.id)) {
        requests.get(ev.data.id)!.value = ev.data.return;
      }
    },
  );

  function defineGetProxy() {
    return new Proxy({}, {
      get(target: any, p: string, receiver: any) {
        return (...argArray: any[]) => {
          const id = idCounter;
          idCounter++;

          clientChannel.postMessage({
            id,
            action: "get",
            name: p,
            args: argArray,
          });

          const req = new ClientRequest(() => {
            clientChannel.postMessage({ id, action: "kill" });
            requests.delete(id);
          });

          requests.set(id, req);

          return req;
        };
      },
    });
  }

  function defineSetProxy() {
    return new Proxy({}, {
      get(target: any, p: string, receiver: any) {
        return (...argArray: any[]) => {
          const id = idCounter;
          idCounter++;

          clientChannel.postMessage({
            id,
            action: "set",
            name: p,
            args: argArray,
          });

          const req = new ClientRequest(() => {});

          requests.set(id, req);

          return req.loaded.then((v) => {
            requests.delete(id);

            return v;
          });
        };
      },
    });
  }

  return {
    get: defineGetProxy(),
    set: defineSetProxy(),
    reset: () => {
      clientChannel.postMessage({ action: "reset" });
    },
  };
}
