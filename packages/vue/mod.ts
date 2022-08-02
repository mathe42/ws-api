import type {
  ClientRequest,
  DefClient,
  Definition,
} from "@ws-api/core";
import { onScopeDispose, shallowReadonly, ShallowRef, shallowRef } from "vue";

function wrapGetRequest<T>(req: ClientRequest<T>) {
  const ref = shallowRef<T | null>(req.value ?? null);

  const fnSub = (val) => {
    ref.value = val;
  };

  req.subscribe(fnSub);

  const kill = () => {
    ref.value = null;
    req.kill();
    req.unsubscribe(fnSub);
  };

  onScopeDispose(kill);

  return {
    ref: shallowReadonly(ref),
    kill,
  };
}

type VueReturn<T> = {
  kill: () => void;
  ref: Readonly<ShallowRef<T>>;
};

type VueClient<DEF extends Definition> = {
  reset: DefClient<DEF>["reset"];
  set: DefClient<DEF>["set"];
  get: {
    [K in keyof DefClient<DEF>["get"]]:
      ReturnType<DefClient<DEF>["get"][K]> extends ClientRequest<infer RET>
        ? (...args: Parameters<DefClient<DEF>["get"][K]>) => VueReturn<RET>
        : null;
  };
};

export function setupVue<DEF extends Definition>(
  client: DefClient<DEF>,
): VueClient<DEF> {
  return {
    set: client.set,
    get: new Proxy({}, {
      get(target, p: string, receiver) {
        return (...args: any[]) =>
          wrapGetRequest(client.get[p](...args as unknown as any));
      },
    }) as any,
    reset: client.reset,
  };
}
