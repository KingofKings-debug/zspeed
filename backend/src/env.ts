import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Resolve from the module so both servers load the same file from src or dist.
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
