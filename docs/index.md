# Websocket API

> This is a (partly) untested framework to create real-time api.

## Scope
This is a framework for a (private) project so features are written with that use case in mind. We try to keep most of it as usecase indepoendent as we can (for example making multiple packages). 

The project uses vite for frontend dev and deno for the backend API. As Websocket API between Bun, NodeJS, Deno differ we try to make the packages as indepoendent as we can. Because of that we only provide logic for when the websocket exists.
