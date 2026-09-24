import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { db, users } from "@/db";
import { eq } from "drizzle-orm";
export async function POST() {
    try {
        const user = await currentUser();
        const email = user?.primaryEmailAddress?.emailAddress;

        if (!email) {
            return NextResponse.json({ error: "You must be signed in with a primary email address." }, { status: 401 });
        }

        const userResult = await db.select().from(users).where(eq(users.email, email));
        if (userResult.length == 0) {
            // User not found, create a new user
            console.log("Creating new user:", user.firstName, email);
            const newUser = await db.insert(users).values({
                name: user.firstName ?? '', email
            }).returning();
            return NextResponse.json({ user: newUser[0] });
        } else {
            return NextResponse.json({ user: userResult[0] });
        }
    } catch (error) {
        console.error("Error creating user:", error);
        return new Response("Internal Server Error", { status: 500 });
    }
}
