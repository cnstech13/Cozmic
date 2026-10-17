// ============================================================
// COZMIC — COMPLETE GROUP CHAT
// Supabase JS v2 | No Edge Functions
// Text, file sharing, voice messages, member profiles, realtime
// ============================================================

"use strict";

// ============================================================
// 1. SUPABASE CLIENT
// ============================================================

const client = window.supabaseClient;

if (!client) {
    throw new Error(
        "Supabase is not initialized. Check script loading order."
    );
}

// ============================================================
// 2. CONFIGURATION
// ============================================================

const TABLES = {
    groups: "chat_groups",
    members: "chat_group_members",
    messages: "chat_group_messages",
    attachments: "chat_group_attachments",
    voices: "chat_group_voice_messages",
    profiles: "profiles"
};

const BUCKETS = {
    files: "shared-files",
    voices: "voice-messages"
};

const MAX_MESSAGE_LENGTH = 5000;
const SIGNED_URL_SECONDS = 3600;

const $ = id => document.getElementById(id);

// ============================================================
// 3. HTML ELEMENTS
// ============================================================

const backButton = $("backButton");
const groupNameElement = $("groupName");
const groupDescriptionElement = $("groupDescription");
const refreshButton = $("refreshButton");
const addMembersButton = $("addMembersButton");

const membersList = $("membersList");
const chatStatus = $("chatStatus");
const messagesArea = $("messagesArea");

const messageForm = $("messageForm");
const messageInput = $("messageInput");
const sendButton = $("sendButton");

const groupFileInput = $("groupFileInput");
const groupFileButton = $("groupFileButton");
const voiceButton = $("voiceButton");

const membersModal = $("membersModal");
const addMemberForm = $("addMemberForm");
const cancelMembersButton = $("cancelMembersButton");

// ============================================================
// 4. APPLICATION STATE
// ============================================================

let currentUser = null;
let currentGroupId = null;
let currentGroup = null;

let messages = [];
let attachments = [];
let voiceMessages = [];
let groupMembers = [];
let profiles = [];

let mediaRecorder = null;
let recordingStream = null;
let recordedChunks = [];
let recordingStartedAt = 0;

let recording = false;
let sendingMessage = false;
let uploadingFile = false;
let refreshing = false;

let refreshTimer = null;
let groupChannel = null;

const signedUrlCache = new Map();

// ============================================================
// 5. GENERAL HELPERS
// ============================================================

function setStatus(message, isError = false) {
    if (!chatStatus) return;

    chatStatus.textContent = message || "";
    chatStatus.style.color = isError ? "#dc2626" : "";
}

function showMessage(message, type = "info") {
    if (window.Swal) {
        return window.Swal.fire({
            text: message,
            icon: type,
            confirmButtonColor: "#0b1f3a"
        });
    }

    alert(message);
    return Promise.resolve();
}

function getErrorMessage(error) {
    return (
        error?.message ||
        error?.error_description ||
        error?.details ||
        "An unexpected error occurred."
    );
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function formatDate(value) {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleString([], {
        dateStyle: "short",
        timeStyle: "short"
    });
}

function formatFileSize(bytes) {
    const size = Number(bytes || 0);

    if (size < 1024) return `${size} B`;
    if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;

    return `${(size / 1048576).toFixed(1)} MB`;
}

function safeFileName(name) {
    return String(name || "attachment")
        .replace(/[^\w.\-() ]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 150);
}

function getGroupIdFromURL() {
    const params = new URLSearchParams(location.search);

    return (
        params.get("group") ||
        params.get("group_id") ||
        params.get("groupId") ||
        params.get("id") ||
        null
    );
}

function getStoragePath(bucket, storedPath) {
    if (!storedPath) {
        throw new Error("The storage file path is missing.");
    }

    let path = String(storedPath).trim();

    // Accept full Supabase Storage URLs.
    if (/^https?:\/\//i.test(path)) {
        let parsedURL;

        try {
            parsedURL = new URL(path);
        } catch {
            throw new Error("The saved storage URL is invalid.");
        }

        const marker = "/storage/v1/object/";
        const markerIndex = parsedURL.pathname.indexOf(marker);

        if (markerIndex === -1) {
            throw new Error(
                "The saved URL is not a recognizable Supabase Storage URL."
            );
        }

        let objectPath = parsedURL.pathname.slice(
            markerIndex + marker.length
        );

        objectPath = objectPath.replace(
            /^(sign|public|authenticated)\//,
            ""
        );

        const prefix = `${bucket}/`;

        if (objectPath.startsWith(prefix)) {
            objectPath = objectPath.slice(prefix.length);
        }

        path = decodeURIComponent(objectPath);
    }

    path = path.replace(/^\/+/, "");

    // Remove a bucket prefix if it was mistakenly saved in the DB.
    if (path.startsWith(`${bucket}/`)) {
        path = path.slice(bucket.length + 1);
    }

    if (!path || path.endsWith("/")) {
        throw new Error("The saved storage path is incomplete.");
    }

    return path;
}

// ============================================================
// 6. AUTHENTICATION
// ============================================================

async function loadCurrentUser() {
    const { data, error } = await client.auth.getUser();

    if (error) throw error;

    if (!data?.user) {
        throw new Error("Please log in before opening a group chat.");
    }

    currentUser = data.user;

    return currentUser;
}

// ============================================================
// 7. GROUP DETAILS AND MEMBERSHIP
// ============================================================

async function loadGroupDetails() {
    const { data, error } = await client
        .from(TABLES.groups)
        .select("*")
        .eq("id", currentGroupId)
        .maybeSingle();

    if (error) throw error;

    if (!data) {
        throw new Error(
            "Group not found, or you do not have permission to view it."
        );
    }

    currentGroup = data;

    if (groupNameElement) {
        groupNameElement.textContent = data.name || "Group Chat";
    }

    if (groupDescriptionElement) {
        groupDescriptionElement.textContent = data.description || "";
    }

    document.title = `${data.name || "Group Chat"} | Cozmic`;
}

async function checkGroupMembership() {
    const { data, error } = await client
        .from(TABLES.members)
        .select("id, group_id, user_id, role, joined_at")
        .eq("group_id", currentGroupId)
        .eq("user_id", currentUser.id)
        .maybeSingle();

    if (error) throw error;

    if (!data) {
        throw new Error("You are not a member of this group.");
    }

    return data;
}

// ============================================================
// 8. MEMBER PROFILES
// ============================================================

async function loadGroupMembers() {
    const { data, error } = await client
        .from(TABLES.members)
        .select("*")
        .eq("group_id", currentGroupId);

    if (error) throw error;

    groupMembers = data || [];

    await loadMemberProfiles();

    renderGroupMembers();
}

async function loadMemberProfiles() {
    const ids = [
        ...new Set(
            groupMembers
                .map(member => member.profile_id || member.user_id)
                .filter(Boolean)
        )
    ];

    profiles = [];

    if (!ids.length) return;

    const { data, error } = await client
        .from(TABLES.profiles)
        .select("*")
        .in("id", ids);

    if (error) {
        console.error("Profile loading error:", error.message);
        return;
    }

    profiles = data || [];
}

function getProfile(userId) {
    return profiles.find(
        profile => String(profile.id) === String(userId)
    ) || null;
}

function getMemberName(userId) {
    const profile = getProfile(userId);

    return profile?.full_name || profile?.username || "Group member";
}

function getProfilePicture(profile) {
    if (!profile) return "";

    return (
        profile.avatar_url ||
        profile.photo_url ||
        profile.profile_picture ||
        profile.profile_image ||
        profile.image_url ||
        profile.avatar ||
        ""
    );
}

function getInitials(name) {
    const words = String(name || "G")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    return words.length > 1
        ? (words[0][0] + words[1][0]).toUpperCase()
        : (words[0]?.slice(0, 2) || "G").toUpperCase();
}

function profileLink(userId) {
    return `profile.html?user=${encodeURIComponent(userId)}`;
}

function renderMemberAvatar(userId, size = 42) {
    const profile = getProfile(userId);
    const name = getMemberName(userId);
    const picture = getProfilePicture(profile);

    const avatar = picture
        ? `
            <img
                src="${escapeHTML(picture)}"
                alt="${escapeHTML(name)}"
                width="${size}"
                height="${size}"
                style="object-fit:cover;border-radius:50%;"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
            >
            <span
                style="display:none;width:${size}px;height:${size}px;border-radius:50%;align-items:center;justify-content:center;background:#17345d;color:white;"
            >${escapeHTML(getInitials(name))}</span>
        `
        : `
            <span
                style="display:flex;width:${size}px;height:${size}px;border-radius:50%;align-items:center;justify-content:center;background:#17345d;color:white;font-weight:bold;"
            >${escapeHTML(getInitials(name))}</span>
        `;

    return `
        <a
            class="cozmic-member-profile-link"
            href="${escapeHTML(profileLink(userId))}"
            aria-label="View ${escapeHTML(name)}'s profile"
            style="display:inline-flex;align-items:center;gap:10px;color:inherit;text-decoration:none;"
        >${avatar}<span>${escapeHTML(name)}</span></a>
    `;
}

function renderGroupMembers() {
    if (!membersList) return;

    if (!groupMembers.length) {
        membersList.innerHTML = "<p>No group members found.</p>";
        return;
    }

    membersList.innerHTML = groupMembers.map(member => {
        const userId = member.profile_id || member.user_id;

        return `
            <div class="group-member">
                ${renderMemberAvatar(userId, 42)}
            </div>
        `;
    }).join("");
}

// ============================================================
// 9. LOAD CHAT RECORDS
// ============================================================

async function loadMessages() {
    const { data, error } = await client
        .from(TABLES.messages)
        .select("*")
        .eq("group_id", currentGroupId)
        .order("created_at", { ascending: true });

    if (error) throw error;

    messages = data || [];
}

async function loadAttachments() {
    const { data, error } = await client
        .from(TABLES.attachments)
        .select("*")
        .eq("group_id", currentGroupId)
        .order("created_at", { ascending: true });

    if (error) throw error;

    attachments = data || [];
}

async function loadGroupVoiceMessages() {
    const { data, error } = await client
        .from(TABLES.voices)
        .select("*")
        .eq("group_id", currentGroupId)
        .order("created_at", { ascending: true });

    if (error) throw error;

    voiceMessages = data || [];
}

// ============================================================
// 10. STORAGE ACCESS
// Checks the actual parent folder before creating a signed URL.
// ============================================================

async function getSignedStorageURL(bucket, storedPath) {
    const path = getStoragePath(bucket, storedPath);
    const cacheKey = `${bucket}:${path}`;

    const cached = signedUrlCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() + 60000) {
        return cached.url;
    }

    const lastSlash = path.lastIndexOf("/");
    const folder = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
    const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

    // List the exact parent folder.
    const { data: files, error: listError } = await client.storage
        .from(bucket)
        .list(folder, {
            limit: 100,
            search: filename
        });

    if (listError) {
        throw new Error(
            `Cannot list folder "${folder}" in "${bucket}": ${listError.message}`
        );
    }

    // Supabase may return folder entries or files. Compare the filename.
    const found = (files || []).some(item => item.name === filename);

    if (!found) {
        console.error("Storage file diagnostic:", {
            bucket,
            storedPath,
            normalizedPath: path,
            folder,
            expectedFilename: filename,
            returnedEntries: (files || []).map(item => item.name)
        });

        throw new Error(
            `The file "${filename}" was not found in Storage folder "${folder}". ` +
            "Check the actual object path and project connection."
        );
    }

    // The exact file exists in the listed folder.
    const { data, error } = await client.storage
        .from(bucket)
        .createSignedUrl(path, SIGNED_URL_SECONDS);

    if (error) {
        console.error("Signed URL creation failed:", {
            bucket,
            path,
            error
        });

        throw new Error(
            `Storage found the folder, but could not create a signed URL ` +
            `for "${path}": ${error.message}`
        );
    }

    if (!data?.signedUrl) {
        throw new Error("Supabase did not return a signed URL.");
    }

    signedUrlCache.set(cacheKey, {
        url: data.signedUrl,
        expiresAt: Date.now() + SIGNED_URL_SECONDS * 1000
    });

    return data.signedUrl;
}

// ============================================================
// 11. SEND TEXT MESSAGE
// ============================================================

async function sendMessage() {
    if (sendingMessage) return;

    const text = (messageInput?.value || "").trim();

    if (!text) return;

    if (text.length > MAX_MESSAGE_LENGTH) {
        await showMessage(
            `Messages cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
            "warning"
        );
        return;
    }

    sendingMessage = true;

    if (sendButton) sendButton.disabled = true;

    try {
        const { error } = await client
            .from(TABLES.messages)
            .insert({
                group_id: currentGroupId,
                sender_id: currentUser.id,
                message_text: text,
                message_type: "text"
            });

        if (error) throw error;

        messageInput.value = "";

        await refreshGroupData();

        setStatus("Message sent.");
    } catch (error) {
        console.error("Send message error:", error);

        setStatus(getErrorMessage(error), true);

        await showMessage(getErrorMessage(error), "error");
    } finally {
        sendingMessage = false;

        if (sendButton) sendButton.disabled = false;

        messageInput?.focus();
    }
}

// ============================================================
// 12. FILE SHARING
// ============================================================

async function uploadAttachment(file) {
    if (!file || uploadingFile) return;

    uploadingFile = true;

    if (groupFileButton) groupFileButton.disabled = true;

    try {
        if (!currentGroupId || !currentUser) {
            throw new Error("Group or login information is missing.");
        }

        setStatus("Uploading file...");

        const path =
            `${currentGroupId}/${currentUser.id}/` +
            `${Date.now()}_${safeFileName(file.name)}`;

        const { data: uploadData, error: uploadError } =
            await client.storage
                .from(BUCKETS.files)
                .upload(path, file, {
                    cacheControl: "3600",
                    upsert: false,
                    contentType: file.type || "application/octet-stream"
                });

        if (uploadError) throw uploadError;

        const storedPath = uploadData?.path || path;

        setStatus("Saving file message...");

        const { data: message, error: messageError } = await client
            .from(TABLES.messages)
            .insert({
                group_id: currentGroupId,
                sender_id: currentUser.id,
                message_text: `Shared a file: ${file.name}`,
                message_type: "text"
            })
            .select("id")
            .single();

        if (messageError) {
            throw new Error(
                "File uploaded, but its message could not be saved: " +
                messageError.message
            );
        }

        if (!message?.id) {
            throw new Error("The new file message did not return an ID.");
        }

        const { error: attachmentError } = await client
            .from(TABLES.attachments)
            .insert({
                message_id: message.id,
                group_id: currentGroupId,
                sender_id: currentUser.id,
                file_name: file.name,
                file_path: storedPath,
                file_type: file.type || "application/octet-stream",
                file_size: file.size
            });

        if (attachmentError) {
            throw new Error(
                "The file uploaded, but its attachment record could not be saved: " +
                attachmentError.message
            );
        }

        await refreshGroupData();

        setStatus("File shared successfully.");

        await showMessage("Your file was shared successfully.", "success");
    } catch (error) {
        console.error("File sharing error:", error);

        setStatus(getErrorMessage(error), true);

        await showMessage(
            "File sharing failed: " + getErrorMessage(error),
            "error"
        );
    } finally {
        uploadingFile = false;

        if (groupFileButton) groupFileButton.disabled = false;

        if (groupFileInput) groupFileInput.value = "";
    }
}

// ============================================================
// 13. VOICE RECORDING
// ============================================================

async function toggleVoiceRecording() {
    if (recording) {
        stopVoiceRecording();
    } else {
        await startVoiceRecording();
    }
}

async function startVoiceRecording() {
    if (!currentGroupId || !currentUser) {
        await showMessage("Open a group before recording.", "error");
        return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        await showMessage(
            "Microphone access requires HTTPS and a supported browser.",
            "error"
        );
        return;
    }

    if (typeof MediaRecorder === "undefined") {
        await showMessage(
            "This browser does not support voice recording.",
            "error"
        );
        return;
    }

    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({
            audio: true
        });

        recordedChunks = [];

        const supportedTypes = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/mp4",
            "audio/ogg;codecs=opus"
        ];

        const options = {};

        for (const type of supportedTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                options.mimeType = type;
                break;
            }
        }

        mediaRecorder = new MediaRecorder(recordingStream, options);

        mediaRecorder.addEventListener("dataavailable", event => {
            if (event.data?.size > 0) {
                recordedChunks.push(event.data);
            }
        });

        mediaRecorder.addEventListener("stop", async () => {
            try {
                await finishVoiceRecording();
            } catch (error) {
                console.error("Voice recording error:", error);

                setStatus(getErrorMessage(error), true);

                await showMessage(getErrorMessage(error), "error");
            } finally {
                stopMicrophoneTracks();
            }
        });

        mediaRecorder.start();

        recording = true;
        recordingStartedAt = Date.now();

        if (voiceButton) {
            voiceButton.textContent = "Stop Recording";
            voiceButton.setAttribute("aria-pressed", "true");
        }

        setStatus("Recording voice message...");
    } catch (error) {
        stopMicrophoneTracks();

        await showMessage(
            "Could not start recording: " + getErrorMessage(error),
            "error"
        );
    }
}

function stopVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }

    recording = false;

    if (voiceButton) {
        voiceButton.textContent = "Record Voice";
        voiceButton.setAttribute("aria-pressed", "false");
    }

    setStatus("Preparing voice message...");
}

function stopMicrophoneTracks() {
    if (recordingStream) {
        recordingStream.getTracks().forEach(track => track.stop());
    }

    recordingStream = null;
    mediaRecorder = null;
    recording = false;

    if (voiceButton) {
        voiceButton.textContent = "Record Voice";
        voiceButton.setAttribute("aria-pressed", "false");
    }
}

async function finishVoiceRecording() {
    if (!recordedChunks.length) {
        throw new Error("No audio was recorded. Please try again.");
    }

    const mimeType = recordedChunks[0].type || "audio/webm";

    const blob = new Blob(recordedChunks, {
        type: mimeType
    });

    const duration = Math.max(
        1,
        Math.round((Date.now() - recordingStartedAt) / 1000)
    );

    recordedChunks = [];

    await uploadVoiceMessage(blob, mimeType, duration);
}

// ============================================================
// 14. UPLOAD VOICE MESSAGE
// ============================================================

async function uploadVoiceMessage(blob, mimeType, durationSeconds) {
    setStatus("Uploading voice message...");

    const extension = mimeType.includes("mp4")
        ? "mp4"
        : mimeType.includes("ogg")
            ? "ogg"
            : "webm";

    const path =
        `${currentGroupId}/${currentUser.id}/` +
        `${Date.now()}.${extension}`;

    const { data: uploadData, error: uploadError } =
        await client.storage
            .from(BUCKETS.voices)
            .upload(path, blob, {
                cacheControl: "3600",
                upsert: false,
                contentType: mimeType
            });

    if (uploadError) throw uploadError;

    const storedPath = uploadData?.path || path;

    // Verify the exact uploaded object before saving the DB record.
    const { data: verification, error: verificationError } =
        await client.storage
            .from(BUCKETS.voices)
            .list(
                storedPath.split("/").slice(0, -1).join("/"),
                {
                    limit: 100,
                    search: storedPath.split("/").pop()
                }
            );

    if (verificationError) {
        throw new Error(
            "Voice uploaded, but Storage verification failed: " +
            verificationError.message
        );
    }

    const uploadedFilename = storedPath.split("/").pop();

    if (!(verification || []).some(item => item.name === uploadedFilename)) {
        throw new Error(
            "Voice upload returned successfully, but the uploaded file " +
            "could not be found at its returned path."
        );
    }

    const { error: insertError } = await client
        .from(TABLES.voices)
        .insert({
            group_id: currentGroupId,
            sender_id: currentUser.id,
            audio_path: storedPath,
            audio_type: mimeType,
            duration_seconds: durationSeconds
        });

    if (insertError) {
        throw new Error(
            "Voice file uploaded, but its database record could not be saved: " +
            getErrorMessage(insertError)
        );
    }

    await refreshGroupData();

    setStatus("Voice message sent successfully.");
}

// ============================================================
// 15. OPEN FILE ATTACHMENT
// ============================================================

async function openAttachment(attachment) {
    try {
        const url = await getSignedStorageURL(
            BUCKETS.files,
            attachment.file_path
        );

        const newWindow = window.open(
            url,
            "_blank",
            "noopener,noreferrer"
        );

        if (!newWindow) {
            await showMessage(
                "Your browser blocked the file window. Allow pop-ups and try again.",
                "warning"
            );
        }
    } catch (error) {
        console.error("Open file error:", error);

        await showMessage(
            "Unable to open file: " + getErrorMessage(error),
            "error"
        );
    }
}

// ============================================================
// 16. RENDER FILE ATTACHMENT
// ============================================================

function renderAttachment(attachment) {
    return `
        <div class="chat-attachment">
            <div class="attachment-details">
                <strong>${escapeHTML(attachment.file_name || "Shared file")}</strong>
                <small>${escapeHTML(formatFileSize(attachment.file_size))}</small>
            </div>

            <button
                type="button"
                class="open-attachment-button"
                data-attachment-id="${escapeHTML(attachment.id)}"
            >Open file</button>
        </div>
    `;
}

// ============================================================
// 17. RENDER VOICE MESSAGE
// ============================================================

function renderVoiceMessage(voice) {
    return `
        <article class="message-row ${
            voice.sender_id === currentUser?.id ? "mine" : ""
        }">
            <div class="bubble">
                <div class="message-sender">
                    ${renderMemberAvatar(voice.sender_id, 32)}
                </div>

                <div class="voice-player">
                    <button
                        type="button"
                        class="load-voice-button"
                        data-voice-id="${escapeHTML(voice.id)}"
                    >Load voice message</button>

                    <div class="voice-audio-container"></div>
                </div>

                <small>
                    ${escapeHTML(formatDate(voice.created_at))}
                    · ${escapeHTML(voice.duration_seconds || 0)} sec
                </small>
            </div>
        </article>
    `;
}

// ============================================================
// 18. LOAD VOICE AUDIO
// ============================================================

async function loadVoiceAudio(voiceId, button) {
    const voice = voiceMessages.find(
        item => String(item.id) === String(voiceId)
    );

    if (!voice) {
        await showMessage("Voice message not found.", "error");
        return;
    }

    const container = button.parentElement.querySelector(
        ".voice-audio-container"
    );

    try {
        button.disabled = true;
        button.textContent = "Loading audio...";

        const url = await getSignedStorageURL(
            BUCKETS.voices,
            voice.audio_path
        );

        const audio = document.createElement("audio");

        audio.controls = true;
        audio.preload = "metadata";
        audio.src = url;
        audio.style.width = "100%";

        audio.addEventListener("error", () => {
            console.error("Audio playback error:", audio.error);

            showMessage(
                "The audio URL was created, but the browser could not play the file. " +
                "The recording format may not be supported.",
                "error"
            );
        }, { once: true });

        container.replaceChildren(audio);

        button.textContent = "Reload voice message";
    } catch (error) {
        console.error("Voice playback error:", error);

        button.textContent = "Retry loading voice";

        await showMessage(
            "Unable to load voice message: " + getErrorMessage(error),
            "error"
        );
    } finally {
        button.disabled = false;
    }
}

// ============================================================
// 19. RENDER TEXT MESSAGE
// ============================================================

function renderTextMessage(message) {
    const linkedAttachments = attachments.filter(
        item => String(item.message_id) === String(message.id)
    );

    return `
        <article class="message-row ${
            message.sender_id === currentUser?.id ? "mine" : ""
        }">
            <div class="bubble">
                <div class="message-sender">
                    ${renderMemberAvatar(message.sender_id, 32)}
                </div>

                <div class="message-text">
                    ${escapeHTML(message.message_text || "")}
                </div>

                ${
                    linkedAttachments.length
                        ? `<div class="message-attachments">
                            ${linkedAttachments.map(renderAttachment).join("")}
                           </div>`
                        : ""
                }

                <small>${escapeHTML(formatDate(message.created_at))}</small>
            </div>
        </article>
    `;
}

// ============================================================
// 20. RENDER ALL CHAT ITEMS
// ============================================================

function renderCombinedMessages() {
    if (!messagesArea) return;

    const combined = [];

    messages.forEach(item => {
        combined.push({
            kind: "text",
            timestamp: item.created_at,
            item
        });
    });

    voiceMessages.forEach(item => {
        combined.push({
            kind: "voice",
            timestamp: item.created_at,
            item
        });
    });

    attachments.forEach(item => {
        const parentExists = item.message_id &&
            messages.some(
                message => String(message.id) === String(item.message_id)
            );

        if (!parentExists) {
            combined.push({
                kind: "attachment",
                timestamp: item.created_at,
                item
            });
        }
    });

    combined.sort((a, b) =>
        new Date(a.timestamp || 0).getTime() -
        new Date(b.timestamp || 0).getTime()
    );

    if (!combined.length) {
        messagesArea.innerHTML = `
            <div class="empty-chat">
                <p>No messages yet.</p>
                <p>Start the conversation!</p>
            </div>
        `;
        return;
    }

    messagesArea.innerHTML = combined.map(entry => {
        if (entry.kind === "text") {
            return renderTextMessage(entry.item);
        }

        if (entry.kind === "voice") {
            return renderVoiceMessage(entry.item);
        }

        return `
            <article class="message-row ${
                entry.item.sender_id === currentUser?.id ? "mine" : ""
            }">
                <div class="bubble">
                    <div class="message-sender">
                        ${renderMemberAvatar(entry.item.sender_id, 32)}
                    </div>

                    ${renderAttachment(entry.item)}

                    <small>${escapeHTML(formatDate(entry.item.created_at))}</small>
                </div>
            </article>
        `;
    }).join("");

    messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ============================================================
// 21. REFRESH CHAT DATA
// ============================================================

async function refreshGroupData() {
    if (!currentGroupId || refreshing) return;

    refreshing = true;

    try {
        await Promise.all([
            loadGroupMembers(),
            loadMessages(),
            loadAttachments(),
            loadGroupVoiceMessages()
        ]);

        renderCombinedMessages();
        setStatus("");
    } catch (error) {
        console.error("Refresh error:", error);

        setStatus(
            "Unable to refresh chat: " + getErrorMessage(error),
            true
        );
    } finally {
        refreshing = false;
    }
}

// ============================================================
// 22. REALTIME UPDATES
// ============================================================

function subscribeToGroupUpdates() {
    if (!currentGroupId) return;

    if (groupChannel) {
        client.removeChannel(groupChannel);
    }

    groupChannel = client
        .channel(`cozmic-group-${currentGroupId}`)
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: TABLES.messages,
            filter: `group_id=eq.${currentGroupId}`
        }, () => refreshGroupData())
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: TABLES.attachments,
            filter: `group_id=eq.${currentGroupId}`
        }, () => refreshGroupData())
        .on("postgres_changes", {
            event: "*",
            schema: "public",
            table: TABLES.voices,
            filter: `group_id=eq.${currentGroupId}`
        }, () => refreshGroupData())
        .subscribe(status => {
            console.log("Group realtime status:", status);
        });
}

// ============================================================
// 23. EVENT LISTENERS
// ============================================================

function setupEventListeners() {
    if (messageForm) {
        messageForm.addEventListener("submit", async event => {
            event.preventDefault();
            await sendMessage();
        });
    }

    if (sendButton && !messageForm) {
        sendButton.addEventListener("click", sendMessage);
    }

    if (groupFileButton && groupFileInput) {
        groupFileButton.addEventListener("click", () => {
            groupFileInput.click();
        });
    }

    if (groupFileInput) {
        groupFileInput.addEventListener("change", async () => {
            const file = groupFileInput.files?.[0];

            if (file) await uploadAttachment(file);
        });
    }

    if (voiceButton) {
        voiceButton.addEventListener("click", toggleVoiceRecording);
    }

    if (refreshButton) {
        refreshButton.addEventListener("click", refreshGroupData);
    }

    if (backButton) {
        backButton.addEventListener("click", () => {
            location.href = "groups.html";
        });
    }

    if (addMembersButton && membersModal) {
        addMembersButton.addEventListener("click", () => {
            membersModal.classList.add("show");
        });
    }

    if (cancelMembersButton && membersModal) {
        cancelMembersButton.addEventListener("click", () => {
            membersModal.classList.remove("show");
        });
    }

    if (addMemberForm) {
        addMemberForm.addEventListener("submit", async event => {
            event.preventDefault();

            await showMessage(
                "Adding members is not implemented in this version.",
                "info"
            );
        });
    }

    if (messagesArea) {
        messagesArea.addEventListener("click", async event => {
            const voiceButtonClicked = event.target.closest(
                ".load-voice-button"
            );

            if (voiceButtonClicked) {
                await loadVoiceAudio(
                    voiceButtonClicked.dataset.voiceId,
                    voiceButtonClicked
                );
                return;
            }

            const fileButtonClicked = event.target.closest(
                ".open-attachment-button"
            );

            if (fileButtonClicked) {
                const attachment = attachments.find(
                    item => String(item.id) ===
                        String(fileButtonClicked.dataset.attachmentId)
                );

                if (attachment) await openAttachment(attachment);
            }
        });
    }
}

// ============================================================
// 24. INITIALIZE
// ============================================================

async function initializeGroupChat() {
    try {
        currentGroupId = getGroupIdFromURL();

        if (!currentGroupId) {
            throw new Error(
                "Group ID missing. Open the group from groups.html."
            );
        }

        setStatus("Loading group chat...");

        await loadCurrentUser();
        await loadGroupDetails();
        await checkGroupMembership();

        setupEventListeners();

        await refreshGroupData();

        subscribeToGroupUpdates();

        if (refreshTimer) clearInterval(refreshTimer);

        refreshTimer = setInterval(refreshGroupData, 30000);

        setStatus("");

        console.log("Cozmic group chat initialized.");
    } catch (error) {
        console.error("Group chat initialization error:", error);

        setStatus(getErrorMessage(error), true);

        await showMessage(getErrorMessage(error), "error");
    }
}

// ============================================================
// 25. CLEANUP
// ============================================================

window.addEventListener("beforeunload", () => {
    if (refreshTimer) clearInterval(refreshTimer);

    if (groupChannel) {
        client.removeChannel(groupChannel);
    }

    stopMicrophoneTracks();
});

// ============================================================
// 26. START
// ============================================================

if (document.readyState === "loading") {
    document.addEventListener(
        "DOMContentLoaded",
        initializeGroupChat
    );
} else {
    initializeGroupChat();
}