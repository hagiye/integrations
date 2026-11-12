import "reflect-metadata";
import { Logger } from "@nestjs/common";

// The services log every settlement and fallback; keep test output readable.
Logger.overrideLogger(false);
