import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables from server/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../server/.env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in ../server/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Hardcoded user for this generator - user can change this file if needed
const email = "ayush.thonge_ug2025@ashoka.edu.in";
const password = "Ayush@Thonge72";

console.log(`Signing in as ${email}...`);

const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password
});

if (error) {
  console.error("Error signing in:", error.message);
  process.exit(1);
}

if (data?.session?.access_token) {
  console.log("\n----------------------------------------");
  console.log("LOGIN SUCCESSFUL");
  console.log("----------------------------------------");
  console.log("\n[User ID]:", data.user.id);
  console.log("\n[Access Token (JWT)]:");
  console.log(data.session.access_token);
  console.log("\n[Refresh Token]:");
  console.log(data.session.refresh_token);
  console.log("\n----------------------------------------");
  console.log("Copy the Access Token above specifically for your 'Authorization: Bearer <token>' header.");
} else {
  console.error("No access token received. Check your credentials.");
  process.exit(1);
}
