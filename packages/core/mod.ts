type JSON_ABLE = any;

export interface FnReturn<RESPONSE extends JSON_ABLE> {
  return: RESPONSE;
  cache: string[];
  prepare?: JSON_ABLE[][];
}
export type Fn<RESPONSE extends JSON_ABLE, ARGS extends JSON_ABLE[]> = (
  ...args: ARGS
) => FnReturn<RESPONSE>;
export type MapFn = Record<string, Fn<any, any>>;
export type Definition = { get: MapFn; set: MapFn };
export type MapFnClientGet<MAP extends MapFn> = {
  [KEY in keyof MAP]: (
    ...args: Parameters<MAP[KEY]>
  ) => ClientRequest<Awaited<ReturnType<MAP[KEY]>["return"]>>;
};
export type MapFnClientSet<T extends MapFn> = {
  [K in keyof T]: (
    ...args: Parameters<T[K]>
  ) => Promise<ReturnType<T[K]>["return"]>;
};
export type DefClient<DEF extends Definition> = {
  get: MapFnClientGet<DEF["get"]>;
  set: MapFnClientSet<DEF["set"]>;
  reset: () => void;
};

export function defineDefinition<T extends Definition>(def: T): T {
  return def;
}

export function setupServer<DEF extends Definition>(definition: DEF) {
  const checkSet = new Set<ServerRequest<any>>()

  function checkCheckSet() {
    checkSet.forEach(req => {
      if(req.instances === 0) {
        req.superKill()
      }
    })

    checkSet.clear()
  }

  setInterval(() => checkCheckSet(), 12*60*60*1000)

  class ServerRequest<T> {
    #value: T
    #invalid: string[]

    private set value(val: T) {
      this.#value = val
      this.isInvalid = false

      this.subscribers.forEach((id, ws) => {
        ws.send(JSON.stringify({id, return: val}))
      })
    }

    instances = 0
    isInvalid = false
    subscribers = new Map<WebSocket, number>()

    kill(ws: WebSocket) {
      this.instances--
      this.subscribers.delete(ws)
    }

    superKill() {
      if(this.instances !== 0) return

      cacheData.get(this.name)?.delete(JSON.stringify(this.args))
        
      this.#invalid.forEach(inv => {
        invalidCache.get(inv)?.delete(this)
      })
    }

    async invalid() {
      if(this.instances === 0) {
        this.isInvalid = true
        return
      }
      const res = await definition.get[this.name](...this.args)

      this.value = res.return
    }
    newRequest(ws: WebSocket, id: number) {
      this.instances++

      if(this.instances === 1 && this.isInvalid) {
        this.invalid()  
      }

      this.subscribers.set(ws, id)

      if(this.#value) {
        ws.send(JSON.stringify({id, return: this.#value}))
      }
    }

    constructor(private name: string, private args: JSON_ABLE[]) {
      (async () => {
        const res = await definition.get[this.name](...this.args)

        this.value = res.return
        this.#invalid = res.cache

        res.cache.forEach(inv => {
          if(!invalidCache.has(inv)) invalidCache.set(inv, new Set())

          invalidCache.get(inv)?.add(this)
        })

        if(res.prepare) {
          const c = cacheData.get(name)!

          res.prepare.forEach(call => {
            if(!c.has(JSON.stringify(call))) {
              const req = new ServerRequest(name, call)

              c.set(JSON.stringify(call), req)
              checkSet.add(req)
            }
          })
        }
      })()
    }
  }

  const cacheData = new Map<
    string,
    Map<string, ServerRequest<any>>
  >();

  const invalidCache = new Map<string, Set<ServerRequest<any>>>();

  function handleCacheInvalid(cache: string[]) {
    cache.forEach((key) =>
      invalidCache.get(key)?.forEach((req) => req.invalid())
    );
  }

  return (ws: WebSocket) => {
    const requests = new Map<number, ServerRequest<any>>();

    ws.addEventListener('close', () => {
      requests.forEach((req, id) => {
        req.kill(ws)
      })

      requests.clear()
    })

    ws.addEventListener("message", async (ev: MessageEvent<string>) => {
      const data: {action: "reset"} | { action: "kill"; id: number } | {
        action: "get" | "set";
        name: string;
        id: number;
        args: JSON_ABLE[];
      } = JSON.parse(ev.data);

      if(data.action === "reset") {
        requests.forEach(req => req.kill(ws))
        requests.clear()
      }

      if (data.action === "kill") {
        requests.get(data.id)?.kill(ws);
      }

      if (data.action === "set") {
        const ret = await definition.set[data.name]?.(...data.args);

        handleCacheInvalid(ret.cache);

        ws.send(JSON.stringify({ id: data.id, return: ret.return }));
      }

      if (data.action === "get") {
        // Check Cache
        const cache = cacheData.get(data.name)?.get(JSON.stringify(data.args));

        if (cache) {
          cache.newRequest(ws, data.id);
          return;
        }

        const req = new ServerRequest<any>(data.name, data.args);

        req.newRequest(ws, data.id);
      }
    });
  };
}

export class ClientRequest<T extends JSON_ABLE> {
  instances = 1;

  #value: T;
  #firstResolve: null | ((a: T) => void);

  #subscriber = new Set<(a: T) => void>();

  loaded = new Promise<T>((res, rej) => {
    this.#firstResolve = res;
  });

  public get value(): T {
    return this.#value;
  }

  public kill() {
    if (this.instances > 1) {
      this.instances--;
      return;
    }
    this.wsKill();
    this.#subscriber.clear();
    this.#value = null as unknown as T;
  }

  public subscribe(cb: (a: T) => void) {
    this.#subscriber.add(cb);
  }

  public unsubscribe(cb: (a: T) => void) {
    this.#subscriber.delete(cb);
  }

  /**
   * @internal
   */
  public set value(a: T) {
    this.#value = a;

    if (this.#firstResolve) {
      this.#firstResolve(a);
      this.#firstResolve = null;
    }

    this.#subscriber.forEach((sub) => sub(a));
  }

  constructor(private wsKill: () => void) {}
}

export function setupClient<DEF extends Definition>(
  ws: WebSocket,
): DefClient<DEF> {
  let idCounter = 0;

  const cacheData = new Map<
    string,
    Map<string, ClientRequest<any>>
  >();

  const requests = new Map<number, ClientRequest<any>>();

  ws.addEventListener("message", (ev: MessageEvent<string>) => {
    const data = JSON.parse(ev.data);

    if (requests.has(data.id)) {
      requests.get(data.id)!.value = data.return;
    }
  });

  function defineGetProxy() {
    return new Proxy({}, {
      get(target: any, p: string, receiver: any) {
        if (!cacheData.has(p)) cacheData.set(p, new Map());

        return (...argArray: JSON_ABLE[]) => {
          const id = idCounter;
          idCounter++;

          const cache = cacheData.get(p)!.get(JSON.stringify(argArray));

          if (cache) {
            cache.instances++;
            return cache;
          }

          ws.send(JSON.stringify({
            id,
            action: "get",
            name: p,
            args: argArray,
          }));

          const req = new ClientRequest(() => {
            ws.send(JSON.stringify({ id, action: "kill" }));
            requests.delete(id);
            cacheData.get(p)!.delete(JSON.stringify(argArray));
          });

          if(!cacheData.has(p)) cacheData.set(p, new Map())

          cacheData.get(p)!.set(JSON.stringify(argArray), req)

          requests.set(id, req);

          return req;
        };
      },
    });
  }

  function defineSetProxy() {
    return new Proxy({}, {
      get(target: any, p: string, receiver: any) {
        if (!cacheData.has(p)) cacheData.set(p, new Map());

        return (...argArray: JSON_ABLE[]) => {
          const id = idCounter;
          idCounter++;

          ws.send(JSON.stringify({
            id,
            action: "set",
            name: p,
            args: argArray,
          }));

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
      ws.send(JSON.stringify({action: 'reset'}))
      cacheData.clear()
    }
  };
}
