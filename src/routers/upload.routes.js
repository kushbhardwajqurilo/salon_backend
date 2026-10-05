import express from "express";
import * as uploadController from "../controllers/upload.controller.js";
import { authenticate } from "../middleware/auth.js";

const router = express.Router();

router.post("/sign", authenticate, uploadController.generateUploadSignature);
router.post("/cleanup", authenticate, uploadController.cleanupUpload);

export default router;
